import pg from "pg";
import Database from "better-sqlite3";
import {
  claimPostgres, ackPostgres, failPostgres, renewPostgres,
  claimSqlite, ackSqlite, failSqlite, renewSqlite,
} from "@claude-project/event-outbox";

/**
 * Reuse exactly the same source connections for the finite CLI and the local
 * supervisor. Never run migrations or open provider / browser connections.
 */
export function requiredEnv(name,env=process.env) {
  const value=env[name]?.trim();
  if(!value)throw new Error("missing required source/destination configuration: "+name);
  return value;
}

export function sourceConnection(source,write) {
  if(source==="blockchain"){
    const filename=requiredEnv("SOLANA_TRADE_DB_PATH");
    const db=new Database(filename,{readonly:!write,fileMustExist:true,timeout:5000});
    try{
      const has=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='outbox_events'").get();
      if(!has)throw new Error("source outbox schema is not installed");
      return {
        kind:"sqlite",connection:db,
        close:async()=>db.close(),
        port:{
          claim:async options=>claimSqlite(db,options),
          ack:async event=>ackSqlite(db,event.id,event.leaseOwner,event.leaseUntil),
          fail:async(event,code,next)=>failSqlite(db,event.id,event.leaseOwner,event.leaseUntil,code,next),
          renew:async(event,leaseMs)=>renewSqlite(db,event.id,event.leaseOwner,event.leaseUntil,leaseMs),
        },
      };
    }catch(error){db.close();throw error;}
  }
  if(!["x","tg"].includes(source))throw new Error("unknown source");
  const url=requiredEnv(source==="x"?"X_SOURCE_DATABASE_URL":"TG_SOURCE_DATABASE_URL");
  const pool=new pg.Pool({
    connectionString:url,max:2,connectionTimeoutMillis:5000,
    query_timeout:30_000,statement_timeout:30_000,
  });
  return {
    kind:"pg",connection:pool,
    close:async()=>pool.end(),
    port:{
      claim:options=>claimPostgres(pool,options),
      ack:event=>ackPostgres(pool,event.id,event.leaseOwner,event.leaseUntil),
      fail:(event,code,next)=>failPostgres(pool,event.id,event.leaseOwner,event.leaseUntil,code,next),
      renew:(event,leaseMs)=>renewPostgres(pool,event.id,event.leaseOwner,event.leaseUntil,leaseMs),
    }
  };
}

export async function checkPgOutbox(pool){
  const {rows}=await pool.query("SELECT to_regclass('outbox_events') IS NOT NULL AS present");
  if(!rows[0]?.present)throw new Error("source outbox schema is not installed");
}

function isoOrNull(value){
  if(value===null||value===undefined)return null;
  const date=value instanceof Date?value:new Date(String(value));
  if(!Number.isFinite(date.getTime()))throw new TypeError("invalid outbox timestamp");
  return date.toISOString();
}

/** Read-only queue health snapshot; does not claim, lease, ACK or mutate events. */
export async function outboxStatus(source,now){
  if(!source||!["pg","sqlite"].includes(source.kind)||!source.connection){
    throw new TypeError("invalid outbox source");
  }
  if(now!==undefined&&(!(now instanceof Date)||!Number.isFinite(now.getTime()))){
    throw new TypeError("invalid health timestamp");
  }
  let row;
  let measuredAt;
  if(source.kind==="sqlite"){
    const localNow=now??new Date();
    const at=localNow.toISOString();
    row=source.connection.prepare(`SELECT
      count(*) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL) AS pending,
      count(*) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL
        AND next_attempt_at<=? AND (lease_until IS NULL OR lease_until<=?)) AS ready,
      count(*) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL
        AND lease_until>?) AS leased,
      count(*) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL AND attempts>0) AS retry_count,
      coalesce(sum(attempts) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL),0) AS retry_attempts_total,
      count(*) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL
        AND attempts>0 AND next_attempt_at>?) AS retry_delayed,
      count(*) FILTER (WHERE dead_lettered_at IS NOT NULL) AS dead_letter,
      (SELECT count(*) FROM (
        SELECT event_kind FROM outbox_events
        WHERE processed_at IS NULL AND dead_lettered_at IS NULL
        GROUP BY event_kind HAVING count(DISTINCT schema_version)>1
      ) AS version_skew) AS schema_version_skew_kinds,
      min(created_at) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL) AS oldest_pending_at,
      max(processed_at) AS last_progress_at,
      max(attempts) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL) AS max_attempts
    FROM outbox_events`).get(at,at,at,at);
    measuredAt=at;
  }else{
    await checkPgOutbox(source.connection);
    const explicitAt=now===undefined?null:now.toISOString();
    const result=await source.connection.query(`WITH observation AS (
      SELECT COALESCE($1::timestamptz, statement_timestamp()) AS measured_at
    ), metrics AS (
      SELECT
        count(*) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL)::text AS pending,
        count(*) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL
          AND next_attempt_at<=observation.measured_at
          AND (lease_until IS NULL OR lease_until<=observation.measured_at))::text AS ready,
        count(*) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL
          AND lease_until>observation.measured_at)::text AS leased,
        count(*) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL AND attempts>0)::text AS retry_count,
        coalesce(sum(attempts) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL),0)::text AS retry_attempts_total,
        count(*) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL
          AND attempts>0 AND next_attempt_at>observation.measured_at)::text AS retry_delayed,
        count(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::text AS dead_letter,
        (SELECT count(*) FROM (
          SELECT event_kind FROM outbox_events
          WHERE processed_at IS NULL AND dead_lettered_at IS NULL
          GROUP BY event_kind HAVING count(DISTINCT schema_version)>1
        ) AS version_skew)::text AS schema_version_skew_kinds,
        min(created_at) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL) AS oldest_pending_at,
        max(processed_at) AS last_progress_at,
        coalesce(max(attempts) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL),0)::text AS max_attempts
      FROM outbox_events CROSS JOIN observation
    )
    SELECT metrics.*, observation.measured_at AS measured_at
    FROM metrics CROSS JOIN observation`,[explicitAt]);
    row=result.rows[0];
    measuredAt=isoOrNull(row.measured_at);
  }
  if(!measuredAt||!Number.isFinite(Date.parse(measuredAt))){
    throw new TypeError("invalid outbox observation timestamp");
  }
  const oldestPendingAt=isoOrNull(row.oldest_pending_at);
  const lastProgressAt=isoOrNull(row.last_progress_at);
  const measuredAtMs=Date.parse(measuredAt);
  const age=(value)=>value===null?null:Math.max(0,measuredAtMs-Date.parse(value));
  return {
    measuredAt,
    pending:Number(row.pending),ready:Number(row.ready),leased:Number(row.leased),
    retryCount:Number(row.retry_count),retryAttemptsTotal:Number(row.retry_attempts_total),
    retryDelayed:Number(row.retry_delayed),deadLetter:Number(row.dead_letter),
    schemaVersionSkewKinds:Number(row.schema_version_skew_kinds),
    oldestPendingAt,oldestPendingAgeMs:age(oldestPendingAt),
    lastProgressAt,lastProgressAgeMs:age(lastProgressAt),
    maxAttempts:Number(row.max_attempts??0),
  };
}

export async function checkDestination(pool,options={}){
  const result=await pool.query(`SELECT
    to_regclass('intelligence_inbox') IS NOT NULL AS inbox,
    to_regclass('entity_registry') IS NOT NULL AS registry,
    to_regclass('entity_evidence') IS NOT NULL AS evidence,
    to_regclass('timeline_events') IS NOT NULL AS timeline,
    to_regclass('token_link_observations') IS NOT NULL AS token_links,
    to_regclass('blockchain_swap_evidence_revisions') IS NOT NULL AS blockchain_revisions`);
  const row=result.rows[0];
  // Every consumer may encounter token-link events, so reject missing 004 before claiming.
  if(!row?.inbox||!row.registry||!row.evidence||!row.timeline||!row.token_links){
    throw new Error("destination Intelligence migrations 001+002+004 required");
  }
  if(options.requireBlockchainRevisions===true && !row.blockchain_revisions){
    throw new Error("destination Intelligence migration 005 required before Blockchain claim");
  }
}

export function destinationConnection(env=process.env){
  return new pg.Pool({
    connectionString:requiredEnv("INTELLIGENCE_DATABASE_URL",env),
    max:3,connectionTimeoutMillis:5000,
    query_timeout:30_000,statement_timeout:30_000,
  });
}
