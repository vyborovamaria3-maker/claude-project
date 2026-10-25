#!/usr/bin/env node
import pg from "pg";
import {preregisterSignalPolicy} from "../dist/index.js";
async function main(){
  if(process.env.INTELLIGENCE_VALIDATION_POLICY_ENABLED!=="true")
    throw new Error("validation_policy_opt_in_required");
  const args=process.argv.slice(2);
  if(args.length!==10||args[0]!=="--signal-version"||args[2]!=="--signal"||
     args[4]!=="--threshold"||args[6]!=="--horizon-hours"||args[8]!=="--code-revision")
    throw new TypeError("invalid_policy_arguments");
  const dsn=process.env.INTELLIGENCE_DATABASE_URL;
  if(!dsn)throw new Error("intelligence_database_required");
  const db=new pg.Client({connectionString:dsn,connectionTimeoutMillis:4000,
    query_timeout:8000,statement_timeout:7000});
  try{
    await db.connect();
    const ready=await db.query("SELECT to_regclass('signal_policy_preregistrations') IS NOT NULL AS ready");
    if(ready.rows[0]?.ready!==true)throw new Error("migration_011_required");
    const id=await preregisterSignalPolicy(db,{
      signalVersion:args[1],signalName:args[3],threshold:Number(args[5]),
      horizonHours:Number(args[7]),codeRevision:args[9]});
    process.stdout.write(JSON.stringify({policyId:id,registered:true})+"\n");
  }finally{await db.end()}
}
main().catch(error=>{
  process.stderr.write(error instanceof Error&&/^[a-z0-9_]+$/.test(error.message)?
    error.message+"\n":"validation_policy_failed\n");
  process.exitCode=1;
});
