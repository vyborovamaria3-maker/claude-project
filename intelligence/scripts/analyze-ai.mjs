#!/usr/bin/env node
import pg from "pg";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {destinationConnection,checkDestination,requiredEnv} from "./etl-connections.mjs";
import {createAiRuntime} from "./ai-runtime.mjs";
import {importAiSourceSnapshots} from "./ai-source-snapshot.mjs";
import {setTimeout as sleep} from "node:timers/promises";

export function sourceQueryTimeout(env=process.env){
  const timeout=Number(env.INTELLIGENCE_AI_SOURCE_QUERY_TIMEOUT_MS??
    (env.INTELLIGENCE_AI_SOURCE_SNAPSHOT_ENABLED==='true'?120000:5000));
  if(!Number.isSafeInteger(timeout)||timeout<1000||timeout>300000)throw new Error("invalid_ai_source_query_timeout");
  return timeout;
}

export async function analyzeOnce(source,env=process.env,watch=false){
  if(!["x","tg"].includes(source))throw new Error("invalid_ai_source");
  if(env.INTELLIGENCE_AI_ENABLED!=="true")throw new Error("ai_explicit_opt_in_required");
  const queryTimeout=sourceQueryTimeout(env);
  const destination=destinationConnection();
  const sourceDb=new pg.Pool({connectionString:requiredEnv(source==="x"?"X_SOURCE_DATABASE_URL":"TG_SOURCE_DATABASE_URL"),
    max:1,connectionTimeoutMillis:5000,statement_timeout:queryTimeout,options:"-c default_transaction_read_only=on"});
  const stop=new AbortController();
  const shutdown=()=>stop.abort();
  for(const signal of ["SIGINT","SIGTERM"])process.once(signal,shutdown);
  try{
    await checkDestination(destination);
    const runtime=await createAiRuntime(destination,{[source]:sourceDb},env);
    do{
      const snapshot=env.INTELLIGENCE_AI_SOURCE_SNAPSHOT_ENABLED==='true'?
        await importAiSourceSnapshots(sourceDb,destination,source,Number(env.INTELLIGENCE_AI_BATCH_SIZE??2)):null;
      const stats={snapshot,...(await runtime.run(source,stop.signal))};
      if(!watch)return stats;
      console.log(JSON.stringify({source,...stats}));
      try{await sleep(5000,undefined,{signal:stop.signal});}catch{break;}
    }while(!stop.signal.aborted);
    return {stopped:true};
  }finally{
    for(const signal of ["SIGINT","SIGTERM"])process.removeListener(signal,shutdown);
    await destination.end();await sourceDb.end();
  }
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const [flag,source,...extra]=process.argv.slice(2);
  if(flag!=="--source"||extra.length>1||extra.length===1&&extra[0]!=="--watch"){console.error("usage: analyze-ai --source x|tg [--watch]");process.exitCode=1;}
  else analyzeOnce(source,process.env,extra[0]==="--watch").then(stats=>{
    console.log(JSON.stringify(stats));if(stats.failed||stats.refreshFailed)process.exitCode=2;
  }).catch(()=>{
    console.error("ai_analysis_failed");process.exitCode=1;
  });
}
