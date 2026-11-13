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

export function postgresSourcePoolOptions(source,write,env=process.env){
  if(!["x","tg"].includes(source)||typeof write!=="boolean")throw new Error("invalid PostgreSQL source connection mode");
  return {
    connectionString:requiredEnv(source==="x"?"X_SOURCE_DATABASE_URL":"TG_SOURCE_DATABASE_URL",env),
    max:2,connectionTimeoutMillis:5000,
    query_timeout:30_000,statement_timeout:30_000,
    application_name:write?"potapoff-intelligence-source-writer":"potapoff-intelligence-source-reader",
    ...(write?{}:{options:"-c default_transaction_read_only=on"}),
  };
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
  const pool=new pg.Pool(postgresSourcePoolOptions(source,write));
  return {
    kind:"pg",connection:pool,
    close:async()=>pool.end(),
    port:{
      claim:options=>claimPostgres(pool,options),
      ack:event=>ackPostgres(pool,event.id,event.leaseOwner,event.leaseUntil),
      fail:(event,code,next,retryDelayMs)=>failPostgres(pool,event.id,event.leaseOwner,event.leaseUntil,code,next,12,retryDelayMs),
      renew:(event,leaseMs)=>renewPostgres(pool,event.id,event.leaseOwner,event.leaseUntil,leaseMs),
    }
  };
}

export async function checkPgOutbox(pool){
  const {rows}=await pool.query("SELECT to_regclass('outbox_events') IS NOT NULL AS present");
  if(!rows[0]?.present)throw new Error("source outbox schema is not installed");
}

export async function checkDestination(pool,options={}){
  const result=await pool.query(`SELECT
    to_regclass('intelligence_inbox') IS NOT NULL AS inbox,
    to_regclass('entity_registry') IS NOT NULL AS registry,
    to_regclass('entity_evidence') IS NOT NULL AS evidence,
    to_regclass('timeline_events') IS NOT NULL AS timeline,
    to_regclass('token_link_observations') IS NOT NULL AS token_links,
    to_regclass('blockchain_swap_evidence_revisions') IS NOT NULL AS blockchain_revisions,
    EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('intelligence_inbox')
      AND attname='payload_sha256' AND NOT attisdropped) AS inbox_fingerprint`);
  const row=result.rows[0];
  // Every consumer may encounter token-link events, so reject missing 004 before claiming.
  if(!row?.inbox||!row.registry||!row.evidence||!row.timeline||!row.token_links){
    throw new Error("destination Intelligence migrations 001+002+004 required");
  }
  if(!row.inbox_fingerprint){
    throw new Error("destination Intelligence migration 017 required before source claims");
  }
  if(options.requireBlockchainRevisions===true && !row.blockchain_revisions){
    throw new Error("destination Intelligence migration 005 required before Blockchain claim");
  }
  // A legacy inbox identity with no payload fingerprint is not a safe
  // idempotent duplicate. Consumers must not claim source events until every
  // legacy row has been verified against its source outbox. The bounded
  // backfill opts into this one precondition explicitly.
  if(options.allowLegacyFingerprints!==true){
    const pending=await pool.query(
      "SELECT EXISTS (SELECT 1 FROM intelligence_inbox WHERE payload_sha256 IS NULL " +
      "AND NOT (source_system='x' AND schema_version='x-unattributed-snapshot-v1')) AS pending",
    );
    if(pending.rows[0]?.pending===true){
      throw new Error("legacy Intelligence inbox fingerprints pending; run the bounded source-outbox backfill before source claims");
    }
  }
}

export function destinationConnection(env=process.env){
  return new pg.Pool({
    connectionString:requiredEnv("INTELLIGENCE_DATABASE_URL",env),
    max:3,connectionTimeoutMillis:5000,
    query_timeout:30_000,statement_timeout:30_000,
  });
}
