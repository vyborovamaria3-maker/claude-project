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
export function requiredEnv(name) {
  const value=process.env[name]?.trim();
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

export async function checkDestination(pool){
  const result=await pool.query(`SELECT
    to_regclass('intelligence_inbox') IS NOT NULL AS inbox,
    to_regclass('entity_registry') IS NOT NULL AS registry,
    to_regclass('entity_evidence') IS NOT NULL AS evidence,
    to_regclass('timeline_events') IS NOT NULL AS timeline,
    to_regclass('token_link_observations') IS NOT NULL AS token_links`);
  const row=result.rows[0];
  // Every consumer may encounter token-link events, so reject missing 004 before claiming.
  if(!row?.inbox||!row.registry||!row.evidence||!row.timeline||!row.token_links){
    throw new Error("destination Intelligence migrations 001+002+004 required");
  }
}

export function destinationConnection(){
  return new pg.Pool({
    connectionString:requiredEnv("INTELLIGENCE_DATABASE_URL"),
    max:3,connectionTimeoutMillis:5000,
    query_timeout:30_000,statement_timeout:30_000,
  });
}
