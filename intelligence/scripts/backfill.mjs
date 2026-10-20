#!/usr/bin/env node
import {pathToFileURL} from "node:url";
import {resolve} from "node:path";
import {createRequire} from "node:module";
import {createHash} from "node:crypto";
import {
  parseBackfillArgs,checkpointFor,readCheckpoint,writeCheckpoint,
  withExclusiveCheckpointLock,advanceCheckpoint,cursorOf,validateCheckpoint,
  buildXSnapshotEvent,buildTgSnapshotEvent,validateRawChainEvidence,
} from "./backfill-core.mjs";
import {sourceConnection,checkPgOutbox} from "./etl-connections.mjs";

const require=createRequire(import.meta.url);
const {buildWalletRawEvent}=require("../../solana-launcher/scripts/blockchain-intelligence-outbox.cjs");

export function validateBackfillGate(options,env=process.env){
  if(!options.execute)return;
  if(env.INTELLIGENCE_BACKFILL_ENABLED!=="true"||
     env.INTELLIGENCE_BACKFILL_WRITE_ENABLED!=="true"){
    throw new Error("explicit_backfill_opt_in_required");
  }
}
/** Hashed DB identity avoids sharing a checkpoint between two different
 * source environments without writing DSNs, SQL passwords or RPC URLs. */
export async function sourceIdentity(source,connection){
  let parts;
  if(source==="blockchain"){
    const entry=connection.pragma("database_list").find(row=>row.name==="main");
    parts={file:entry?.file??""};
  }else{
    const {rows}=await connection.query(
      "SELECT current_database() AS database,current_schema() AS schema,"+
      "current_user AS user,inet_server_addr()::text AS server,"+
      "inet_server_port() AS port");
    parts=rows[0];
    if(!parts)throw new Error("database_identity_unavailable");
  }
  return createHash("sha256").update(JSON.stringify([source,parts])).digest("hex");
}
export async function readHighWater(source,connection){
  if(source==="x"){
    const {rows}=await connection.query(
      "SELECT tweet_id FROM twitter_tweets WHERE tweet_id ~ '^[1-9][0-9]{0,24}$' "+
      "ORDER BY char_length(tweet_id) DESC,tweet_id DESC LIMIT 1");
    return rows.length?cursorOf("x",rows[0]):null;
  }
  if(source==="tg"){
    const {rows}=await connection.query(
      "SELECT source_id::text,message_id::text FROM tg_messages WHERE message_id>0 "+
      "ORDER BY source_id DESC,message_id DESC LIMIT 1");
    return rows.length?cursorOf("tg",rows[0]):null;
  }
  const row=connection.prepare(
    "SELECT address,signature FROM chain_seed_events WHERE kind='wallet' "+
    "ORDER BY address DESC,signature DESC LIMIT 1").get();
  return row?cursorOf("blockchain",row):null;
}

const SELECT_X="SELECT t.tweet_id,t.author_id,t.updated_at,t.posted_at "+
  "FROM twitter_tweets t "+
  "WHERE t.tweet_id ~ '^[1-9][0-9]{0,24}$' "+
  "AND (char_length(t.tweet_id),t.tweet_id)>($1::integer,$2::text) "+
  "AND (char_length(t.tweet_id),t.tweet_id)<=($3::integer,$4::text) "+
  "ORDER BY char_length(t.tweet_id),t.tweet_id LIMIT $5";

const SELECT_TG="SELECT m.source_id::text,m.message_id::text,s.peer_id,"+
  "m.collected_at,m.posted_at,m.deleted_at,m.text "+
  "FROM tg_messages m JOIN tg_sources s ON s.id=m.source_id "+
  "WHERE m.message_id>0 AND m.deleted_at IS NULL "+
  "AND (m.source_id,m.message_id)>($1::bigint,$2::bigint) "+
  "AND (m.source_id,m.message_id)<=($3::bigint,$4::bigint) "+
  "ORDER BY m.source_id,m.message_id LIMIT $5";

function pgPageArgs(source,checkpoint,limit){
  const c=checkpoint.cursor,h=checkpoint.high;
  if(source==="x")return [c.len,c.id,h.len,h.id,limit];
  return [c.sourceId,c.messageId,h.sourceId,h.messageId,limit];
}
async function insertPgOutbox(client,event){
  const payload=JSON.stringify(event.payload);
  const args=[event.sourceSystem,event.eventKind,event.eventKey,event.schemaVersion,payload];
  const inserted=await client.query(
    "INSERT INTO outbox_events(source_system,event_kind,event_key,schema_version,payload) "+
    "VALUES($1,$2,$3,$4,$5::jsonb) "+
    "ON CONFLICT(source_system,event_kind,event_key) DO NOTHING RETURNING id",args);
  if(inserted.rowCount===1)return true;
  const existing=await client.query(
    "SELECT schema_version=$4::text AND payload=$5::jsonb AS identical "+
    "FROM outbox_events WHERE source_system=$1 AND event_kind=$2 AND event_key=$3",args);
  if(existing.rows[0]?.identical!==true)throw new TypeError("backfill event identity collision");
  return false;
}
function insertSqliteOutbox(db,event){
  const payload=JSON.stringify(event.payload);
  const now=new Date().toISOString();
  const inserted=db.prepare(
    "INSERT OR IGNORE INTO outbox_events "+
    "(source_system,event_kind,event_key,schema_version,payload,created_at,next_attempt_at) "+
    "VALUES(?,?,?,?,?,?,?)").run(
      event.sourceSystem,event.eventKind,event.eventKey,event.schemaVersion,payload,now,now);
  if(inserted.changes===1)return true;
  const existing=db.prepare(
    "SELECT schema_version,payload FROM outbox_events "+
    "WHERE source_system=? AND event_kind=? AND event_key=?").get(
      event.sourceSystem,event.eventKind,event.eventKey);
  if(!existing||existing.schema_version!==event.schemaVersion||
     JSON.stringify(JSON.parse(existing.payload))!==payload){
    throw new TypeError("backfill event identity collision");
  }
  return false;
}

/** The checkpoint is saved separately AFTER commit. A crash after commit
 * replays events through source Outbox idempotency. */
export async function processPgPage(pool,source,state,limit,execute){
  if(!["x","tg"].includes(source))throw new TypeError("Unsupported PG source");
  if(state.complete||state.high===null)return {rows:[],stats:{inserted:0,duplicates:0,excluded:0}};
  const reader=execute?await pool.connect():pool;
  let inTransaction=false;
  try{
    if(execute){await reader.query("BEGIN");inTransaction=true;}
    const query=(source==="x"?SELECT_X:SELECT_TG)+
      (execute?" FOR UPDATE OF "+(source==="x"?"t":"m"):"");
    const {rows}=await reader.query(query,pgPageArgs(source,state,limit));
    let inserted=0,duplicates=0,excluded=0;
    for(const row of rows){
      const event=source==="x"?buildXSnapshotEvent(row):buildTgSnapshotEvent(row);
      if(!event){excluded++;continue;}
      if(execute){
        if(await insertPgOutbox(reader,event))inserted++;else duplicates++;
      }
    }
    if(inTransaction){await reader.query("COMMIT");inTransaction=false;}
    return {rows,stats:{inserted,duplicates,excluded}};
  }catch(error){
    if(inTransaction)try{await reader.query("ROLLBACK")}catch{ /* original error wins */ }
    throw error;
  }finally{
    if(execute)reader.release();
  }
}
const SELECT_CHAIN="SELECT kind,address,signature,block_time,observed_at,payload_hash "+
  "FROM chain_seed_events WHERE kind='wallet' "+
  "AND (address>? OR (address=? AND signature>?)) "+
  "AND (address<? OR (address=? AND signature<=?)) "+
  "ORDER BY address,signature LIMIT ?";

export function processSqlitePage(db,state,limit,execute){
  if(state.complete||state.high===null)return {rows:[],stats:{inserted:0,duplicates:0,excluded:0}};
  const args=[state.cursor.address,state.cursor.address,state.cursor.signature,
    state.high.address,state.high.address,state.high.signature,limit];
  const work=()=>{
    const rows=db.prepare(SELECT_CHAIN).all(...args);
    let inserted=0,duplicates=0;
    for(const row of rows){
      validateRawChainEvidence(row);
      const event=buildWalletRawEvent({
        kind:"wallet",address:row.address,signature:row.signature,
        payloadHash:row.payload_hash,blockTime:row.block_time,
        observedAt:row.observed_at,
      });
      if(!event)throw new TypeError("wallet evidence is not exportable");
      if(execute){
        if(insertSqliteOutbox(db,event))inserted++;else duplicates++;
      }
    }
    return {rows,stats:{inserted,duplicates,excluded:0}};
  };
  return execute?db.transaction(work).immediate():work();
}

export async function runOneBackfillPage(options,dependencies={}){
  validateBackfillGate(options,dependencies.env??process.env);
  const connection=dependencies.connection??sourceConnection(options.source,options.execute);
  const ownsConnection=!dependencies.connection;
  try{
    if(connection.kind==="pg")await checkPgOutbox(connection.connection);
    const identity=await sourceIdentity(options.source,connection.connection);
    const existing=options.execute
      ?await readCheckpoint(options.checkpoint,options.source,options.scope,identity):null;
    const high=existing?existing.high:
      await readHighWater(options.source,connection.connection);
    const state=existing??checkpointFor(options.source,options.scope??"dry-run",high,identity);
    validateCheckpoint(state,options.source,options.scope??"dry-run",identity);
    if(options.execute&&!existing)await writeCheckpoint(options.checkpoint,state);
    const page=connection.kind==="pg"
      ?await processPgPage(connection.connection,options.source,state,options.limit,options.execute)
      :processSqlitePage(connection.connection,state,options.limit,options.execute);
    const next=advanceCheckpoint(state,page.rows,page.stats,options.source);
    if(options.execute)await writeCheckpoint(options.checkpoint,next);
    return {
      source:options.source,mode:options.execute?"execute":"dry_run",
      scanned:page.rows.length,inserted:page.stats.inserted,
      duplicates:page.stats.duplicates,excluded:page.stats.excluded,
      cumulativeVisited:next.visited,cumulativeInserted:next.inserted,
      cumulativeExcluded:next.excluded,complete:next.complete,
      note:options.execute?"source_outbox_only":"no_writes_or_provider_requests",
    };
  }finally{if(ownsConnection)await connection.close();}
}

const usage=[
  "ARCH-08 source Outbox backfill (foreground, one page, never calls X/TG/Alchemy/RPC).",
  "Dry run: node scripts/backfill.mjs --source x|tg|blockchain --limit 20",
  "Write: INTELLIGENCE_BACKFILL_ENABLED=true INTELLIGENCE_BACKFILL_WRITE_ENABLED=true",
  "  node scripts/backfill.mjs --source tg --limit 20 --execute",
  "    --scope local-tg-db --checkpoint /path/to/unique-tg-checkpoint.json",
  "Write needs existing source outbox schema and backed-up source DB.",
  "Repeat the command until complete=true; no hidden continuous loop.",
  "Checkpoint stores only source keys/counts, never credentials or message text.",
].join("\n");
async function main(){
  const options=parseBackfillArgs(process.argv.slice(2));
  if(options.help){console.log(usage);return;}
  const run=()=>runOneBackfillPage(options);
  const stats=options.execute
    ?await withExclusiveCheckpointLock(options.checkpoint,run):await run();
  console.log(JSON.stringify(stats));
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  main().catch(()=>{
    // Database error details/DSNs may contain secrets. Log only stable codes.
    console.error("source backfill failed: validation_or_database_operation_failed");
    process.exitCode=1;
  });
}
