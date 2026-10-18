#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import pg from "pg";
import Database from "better-sqlite3";
import {
  claimPostgres, ackPostgres, failPostgres,
  claimSqlite, ackSqlite, failSqlite,
} from "@claude-project/event-outbox";
import { runDeliveryBatch } from "../dist/index.js";

/**
 * Explicit, bounded local ETL command. No background service or automatic
 * source migrations. Does not connect to X/Telegram platforms or Solana RPC.
 */
function argumentsFor(argv) {
  const options={source:null,once:false,status:false,limit:50,help:false};
  for(let i=0;i<argv.length;i++){
    const arg=argv[i];
    if(arg==="--help"||arg==="-h") options.help=true;
    else if(arg==="--once") options.once=true;
    else if(arg==="--status") options.status=true;
    else if(arg==="--source"){
      options.source=argv[++i];
    }else if(arg.startsWith("--source=")){
      options.source=arg.slice("--source=".length);
    }else if(arg==="--limit"){
      options.limit=Number(argv[++i]);
    }else if(arg.startsWith("--limit=")){
      options.limit=Number(arg.slice("--limit=".length));
    }else throw new Error("unknown CLI option");
  }
  if(options.help)return options;
  if(!["x","tg","blockchain"].includes(options.source)) throw new Error("select --source x|tg|blockchain");
  if(options.once===options.status) throw new Error("select exactly one of --once or --status");
  if(!Number.isSafeInteger(options.limit)||options.limit<1||options.limit>1000)throw new Error("limit must be 1..1000");
  return options;
}
function usage() {
  return [
    "Intelligence local ETL (no source or remote collection is started)",
    "  node scripts/run.mjs --source x|tg|blockchain --status",
    "  INTELLIGENCE_ETL_ENABLED=true node scripts/run.mjs --source x|tg|blockchain --once --limit 50",
    "Source env: X_SOURCE_DATABASE_URL, TG_SOURCE_DATABASE_URL, SOLANA_TRADE_DB_PATH",
    "Destination env: INTELLIGENCE_DATABASE_URL (required for --once)",
    "Preconditions: source outbox schema and destination migrations 001+002",
  ].join("\n");
}
function requiredEnv(name) {
  const value=process.env[name]?.trim();
  if(!value)throw new Error("missing required source/destination configuration: "+name);
  return value;
}
function sourceConnection(source,once) {
  if(source==="blockchain"){
    const filename=requiredEnv("SOLANA_TRADE_DB_PATH");
    const db=new Database(filename,{readonly:!once,fileMustExist:true});
    try{
      const has=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='outbox_events'").get();
      if(!has)throw new Error("source outbox schema is not installed");
      return {
        kind:"sqlite",connection:db,
        close:async()=>db.close(),
        port:{
          claim:async options=>claimSqlite(db,options),
          ack:async event=>ackSqlite(db,event.id,event.leaseOwner),
          fail:async(event,code,next)=>failSqlite(db,event.id,event.leaseOwner,code,next)
        },
      };
    }catch(error){db.close();throw error;}
  }
  const url=requiredEnv(source==="x"?"X_SOURCE_DATABASE_URL":"TG_SOURCE_DATABASE_URL");
  const pool=new pg.Pool({connectionString:url,max:2,connectionTimeoutMillis:5000});
  return {
    kind:"pg",connection:pool,
    close:async()=>pool.end(),
    port:{
      claim:options=>claimPostgres(pool,options),
      ack:event=>ackPostgres(pool,event.id,event.leaseOwner),
      fail:(event,code,next)=>failPostgres(pool,event.id,event.leaseOwner,code,next),
    }
  };
}
async function checkPgOutbox(pool){
  const {rows}=await pool.query("SELECT to_regclass('outbox_events') IS NOT NULL AS present");
  if(!rows[0]?.present)throw new Error("source outbox schema is not installed");
}
async function status(source){
  if(source.kind==="sqlite"){
    const row=source.connection.prepare(`SELECT
      (SELECT count(*) FROM outbox_events WHERE processed_at IS NULL AND dead_lettered_at IS NULL) AS pending,
      (SELECT count(*) FROM outbox_events WHERE dead_lettered_at IS NOT NULL) AS dead_letter`).get();
    return {pending:Number(row.pending),deadLetter:Number(row.dead_letter)};
  }
  await checkPgOutbox(source.connection);
  const {rows}=await source.connection.query(`SELECT
    (SELECT count(*)::text FROM outbox_events WHERE processed_at IS NULL AND dead_lettered_at IS NULL) AS pending,
    (SELECT count(*)::text FROM outbox_events WHERE dead_lettered_at IS NOT NULL) AS dead_letter`);
  return {pending:Number(rows[0].pending),deadLetter:Number(rows[0].dead_letter)};
}
async function checkDestination(pool){
  const result=await pool.query(`SELECT
    to_regclass('intelligence_inbox') IS NOT NULL AS inbox,
    to_regclass('entity_registry') IS NOT NULL AS registry,
    to_regclass('entity_evidence') IS NOT NULL AS evidence,
    to_regclass('timeline_events') IS NOT NULL AS timeline`);
  const row=result.rows[0];
  if(!row?.inbox||!row.registry||!row.evidence||!row.timeline){
    throw new Error("destination Intelligence migrations 001+002 required");
  }
}
async function main(){
  const args=argumentsFor(process.argv.slice(2));
  if(args.help){console.log(usage());return;}
  if(args.once && process.env.INTELLIGENCE_ETL_ENABLED!=="true"){
    throw new Error("set INTELLIGENCE_ETL_ENABLED=true for explicit delivery");
  }
  const source=sourceConnection(args.source,args.once);
  let destination;
  try{
    if(args.status){
      console.log(JSON.stringify({source:args.source,mode:"status",...(await status(source))}));
      return;
    }
    if(source.kind==="pg")await checkPgOutbox(source.connection);
    destination=new pg.Pool({
      connectionString:requiredEnv("INTELLIGENCE_DATABASE_URL"),
      max:2,connectionTimeoutMillis:5000,
    });
    await checkDestination(destination);
    const stats=await runDeliveryBatch(source.port,destination,{
      workerId:randomUUID(),batchSize:args.limit,leaseMs:120_000,
    });
    console.log(JSON.stringify({source:args.source,mode:"once",...stats}));
    if(stats.failed>0||stats.lostLeases>0)process.exitCode=2;
  }finally{
    if(destination)await destination.end();
    await source.close();
  }
}
main().catch(error=>{
  // Error strings/URLs can carry source account/database credentials.
  // Only a bounded, nonsecret error classification is printed.
  const allowlisted = error instanceof Error && (
    error.message === "set INTELLIGENCE_ETL_ENABLED=true for explicit delivery" ||
    /^(select exactly one|select --source|limit must|unknown CLI option)/.test(error.message)
  );
  console.error("intelligence ETL failed:", allowlisted ? error.message : "source_or_destination_operation_failed");
  process.exitCode=1;
});
