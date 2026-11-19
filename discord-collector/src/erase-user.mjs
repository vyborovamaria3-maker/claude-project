import pg from "pg";
import {IngressSpool,parseIngressSpoolKey} from "./ingress-spool.mjs";
import {eraseUserMessages,installSchema} from "./storage.mjs";

const authorId=process.env.DISCORD_ERASURE_AUTHOR_ID;
if(process.env.DISCORD_USER_ERASURE_ENABLED!=="true")
  throw new Error("DISCORD_USER_ERASURE_ENABLED must be explicitly true");
if(!process.env.DISCORD_SOURCE_DATABASE_URL)
  throw new Error("DISCORD_SOURCE_DATABASE_URL is required");
if(!authorId)throw new Error("DISCORD_ERASURE_AUTHOR_ID is required");
if(!process.env.DISCORD_INGRESS_SPOOL_DIR||!process.env.DISCORD_INGRESS_SPOOL_KEY)
  throw new Error("Persistent ingress spool and its key are required");

const pool=new pg.Pool({connectionString:process.env.DISCORD_SOURCE_DATABASE_URL,max:3});
let lockClient=null;
let spool=null;
try{
  // Exclude a live Collector so no new author events can enter the spool or
  // source database between spool erasure and the transactional DB deletion.
  lockClient=await pool.connect();
  const lock=await lockClient.query(
    "SELECT pg_try_advisory_lock(hashtextextended('potapoff:discord-collector:singleton',0)) AS acquired",
  );
  if(lock.rows[0]?.acquired!==true)
    throw new Error("collector_already_running");

  await installSchema(pool);
  const key=parseIngressSpoolKey(process.env.DISCORD_INGRESS_SPOOL_KEY);
  try{
    spool=new IngressSpool({
      directory:process.env.DISCORD_INGRESS_SPOOL_DIR,key,
    }).open();
  }finally{key.fill(0)}
  const spoolResult=spool.eraseAuthor(authorId);

  const schema=await pool.query(
    "SELECT to_regclass('discord_messages') IS NOT NULL AS messages,"+
    "to_regclass('discord_message_revisions') IS NOT NULL AS revisions,"+
    "to_regclass('discord_message_tombstones') IS NOT NULL AS tombstones,"+
    "to_regclass('discord_coverage_failures') IS NOT NULL AS coverage,"+
    "to_regclass('outbox_events') IS NOT NULL AS outbox",
  );
  const state=schema.rows[0];
  if(!state||Object.values(state).some(value=>value!==true))
    throw new Error("discord_source_schema_incomplete");
  const result=await eraseUserMessages(pool,authorId);
  console.log(JSON.stringify({
    operation:"discord_user_erasure",
    spoolEventsErased:spoolResult.eventsErased,
    messagesErased:result.messagesErased,
    revisionsErased:result.revisionsErased,
    tombstonesQueued:result.tombstonesQueued,
    coverageFailuresErased:result.coverageFailuresErased,
  }));
}catch{
  console.error("Discord user erasure failed; no author ID or database details were logged");
  process.exitCode=1;
}finally{
  try{spool?.close()}catch{}
  if(lockClient){
    try{
      await lockClient.query(
        "SELECT pg_advisory_unlock(hashtextextended('potapoff:discord-collector:singleton',0))",
      );
    }catch{}
    lockClient.release();
  }
  await pool.end();
}
