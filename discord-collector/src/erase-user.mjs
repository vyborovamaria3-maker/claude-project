import pg from "pg";
import {eraseUserMessages} from "./storage.mjs";

const authorId=process.env.DISCORD_ERASURE_AUTHOR_ID;
if(process.env.DISCORD_USER_ERASURE_ENABLED!=="true")
  throw new Error("DISCORD_USER_ERASURE_ENABLED must be explicitly true");
if(!process.env.DISCORD_SOURCE_DATABASE_URL)
  throw new Error("DISCORD_SOURCE_DATABASE_URL is required");
if(!authorId)throw new Error("DISCORD_ERASURE_AUTHOR_ID is required");

const pool=new pg.Pool({connectionString:process.env.DISCORD_SOURCE_DATABASE_URL,max:2});
try{
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
    messagesErased:result.messagesErased,
    revisionsErased:result.revisionsErased,
    tombstonesQueued:result.tombstonesQueued,
    coverageFailuresErased:result.coverageFailuresErased,
  }));
}catch{
  console.error("Discord user erasure failed; no author ID or database details were logged");
  process.exitCode=1;
}finally{
  await pool.end();
}
