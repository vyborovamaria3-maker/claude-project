#!/usr/bin/env node
import pg from "pg";
import {processInvalidationBatch} from "../dist/index.js";

// Only opt-in destination mutations. No source connection, migrations, or
// provider requests. Safe to run repeatedly from an existing scheduler.
async function main(){
  if(process.env.INTELLIGENCE_INVALIDATION_WORKER_ENABLED!=="true")
    throw new Error("invalidation_worker_opt_in_required");
  const dsn=process.env.INTELLIGENCE_DATABASE_URL;
  if(!dsn)throw new Error("intelligence_database_required");
  const limit=Number(process.env.INTELLIGENCE_INVALIDATION_BATCH_SIZE??"4");
  if(!Number.isSafeInteger(limit)||limit<1||limit>20)
    throw new Error("invalid_invalidation_batch_size");
  const db=new pg.Client({connectionString:dsn,connectionTimeoutMillis:4000,
    query_timeout:40000,statement_timeout:35000});
  try{
    await db.connect();
    const ready=await db.query("SELECT to_regclass('analytics_invalidation_queue') IS NOT NULL AS ready");
    if(ready.rows[0]?.ready!==true)throw new Error("intelligence_migration_010_required");
    const retryColumn=await db.query(`SELECT EXISTS(SELECT 1 FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='analytics_invalidation_queue'
        AND column_name='next_attempt_at') AS ready`);
    if(retryColumn.rows[0]?.ready!==true)throw new Error("intelligence_migration_013_required");
    const result=await processInvalidationBatch(db,limit);
    process.stdout.write(JSON.stringify(result)+"\n");
  }finally{await db.end()}
}
main().catch(error=>{
  process.stderr.write(error instanceof Error&&/^[a-z0-9_]+$/.test(error.message)
    ?error.message+"\n":"invalidation_batch_failed\n");
  process.exitCode=1;
});
