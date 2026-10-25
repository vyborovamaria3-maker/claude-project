#!/usr/bin/env node
import pg from "pg";
import {purgeEncryptedEventText} from "../dist/index.js";
async function main(){
  if(process.env.INTELLIGENCE_TEXT_SNAPSHOT_PURGE_ENABLED!=="true")
    throw new Error("text_snapshot_purge_opt_in_required");
  if(!process.env.INTELLIGENCE_DATABASE_URL)
    throw new Error("destination_database_config_required");
  const db=new pg.Client({connectionString:process.env.INTELLIGENCE_DATABASE_URL,
    connectionTimeoutMillis:4000,statement_timeout:15000,query_timeout:18000});
  try{
    await db.connect();
    await db.query("BEGIN");
    try{
      const count=await purgeEncryptedEventText(db,500);
      await db.query("COMMIT");
      process.stdout.write(JSON.stringify({purged:count})+"\n");
    }catch(error){await db.query("ROLLBACK");throw error}
  }finally{await db.end()}
}
main().catch(()=>{process.stderr.write("text_snapshot_purge_failed\n");process.exitCode=1});
