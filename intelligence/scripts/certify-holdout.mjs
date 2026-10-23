#!/usr/bin/env node
import pg from "pg";
import {certifyTemporalHoldout} from "../dist/index.js";
async function main(){
  if(process.env.INTELLIGENCE_VALIDATION_ENABLED!=="true")
    throw new Error("validation_opt_in_required");
  const values=process.argv.slice(2);
  if(values.length!==6||values[0]!=="--run-id"||values[2]!=="--signal-version"||
     values[4]!=="--code-revision")throw new TypeError("invalid_validation_arguments");
  if(!process.env.INTELLIGENCE_DATABASE_URL)throw new Error("intelligence_database_required");
  const db=new pg.Client({connectionString:process.env.INTELLIGENCE_DATABASE_URL,
    connectionTimeoutMillis:4000,query_timeout:30000,statement_timeout:25000});
  try{
    await db.connect();
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    try{
      const ready=await db.query("SELECT to_regclass('signal_validation_registry') IS NOT NULL AS ready");
      if(ready.rows[0]?.ready!==true)throw new Error("migration_010_required");
      const result=await certifyTemporalHoldout(db,{
        runId:values[1],signalVersion:values[3],codeRevision:values[5]});
      await db.query("COMMIT");
      process.stdout.write(JSON.stringify(result)+"\n");
    }catch(error){await db.query("ROLLBACK");throw error}
  }finally{await db.end()}
}
main().catch(error=>{
  process.stderr.write(error instanceof Error&&/^[a-z0-9_]+$/.test(error.message)?
    error.message+"\n":"validation_failed\n");
  process.exitCode=1;
});
