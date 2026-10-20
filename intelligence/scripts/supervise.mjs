#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runDeliveryBatch } from "../dist/index.js";
import {
  sourceConnection, checkPgOutbox, checkDestination, destinationConnection,
} from "./etl-connections.mjs";
import { runSourceLoop } from "./supervisor-core.mjs";

/**
 * Foreground-only, laptop-local ETL process. Nothing runs unless explicitly
 * invoked with both opt-in gates and verified existing source/target schemas.
 * No source collection, browser sessions, MTProto, RPC or migrations.
 */
export function parseArguments(args){
  const options={
    sources:[],pollMs:2000,paceMs:100,leaseMs:120_000,maxFailures:5,
    maxBatches:0,help:false,
  };
  let provided=false;
  const numeric={
    "--poll-ms":["pollMs",100,60_000],
    "--pace-ms":["paceMs",0,60_000],
    "--lease-ms":["leaseMs",1000,3_600_000],
    "--max-failures":["maxFailures",1,100],
    "--max-batches":["maxBatches",0,1_000_000],
  };
  for(let i=0;i<args.length;i++){
    const raw=args[i];
    if(raw==="--help"||raw==="-h"){options.help=true;continue}
    const [name,inline]=raw.includes("=")?[raw.slice(0,raw.indexOf("=")),raw.slice(raw.indexOf("=")+1)]:[raw,null];
    if(name==="--sources"||name==="--source"){
      if(provided)throw new Error("sources specified twice");
      provided=true;
      const value=inline??args[++i];
      if(!value)throw new Error("missing sources");
      const sources=value.split(",").map(x=>x.trim());
      if(sources.length===0||new Set(sources).size!==sources.length||
          sources.some(s=>!["x","tg","blockchain"].includes(s))){
        throw new Error("invalid sources");
      }
      options.sources=sources;
      continue;
    }
    if(Object.hasOwn(numeric,name)){
      const [key,min,max]=numeric[name];
      const rawValue=inline??args[++i];
      const value=Number(rawValue);
      if(rawValue===undefined||rawValue===""||!Number.isSafeInteger(value)||value<min||value>max){
        throw new Error("invalid supervisor numeric option");
      }
      options[key]=value;
      continue;
    }
    throw new Error("unknown CLI option");
  }
  if(!options.help&&!options.sources.length)throw new Error("select --sources x,tg,blockchain");
  return options;
}

function usage(){
  return [
    "Local Intelligence ETL supervisor (foreground process, no collectors started)",
    "  INTELLIGENCE_ETL_ENABLED=true INTELLIGENCE_SUPERVISOR_ENABLED=true \\",
    "    node scripts/supervise.mjs --sources x,tg,blockchain",
    "  Optional --poll-ms 2000 --pace-ms 100 --lease-ms 120000",
    "           --max-failures 5 --max-batches 0",
    "  --max-batches N is a per-source upper bound; 0 means until SIGINT/SIGTERM.",
    "  Use --sources x or --sources tg,blockchain to run only configured sources.",
    "  X_SOURCE_DATABASE_URL, TG_SOURCE_DATABASE_URL, SOLANA_TRADE_DB_PATH",
    "  INTELLIGENCE_DATABASE_URL: separate target PostgreSQL with migrations 001+002+004.",
    "  Requires existing source outbox schemas; does NOT apply migrations.",
    "  Preserve separate producer opt-ins; never point this at live DBs before backup/restore.",
  ].join("\n");
}

async function main(){
  const options=parseArguments(process.argv.slice(2));
  if(options.help){console.log(usage());return}
  if(process.env.INTELLIGENCE_ETL_ENABLED!=="true" ||
     process.env.INTELLIGENCE_SUPERVISOR_ENABLED!=="true"){
    throw new Error("supervisor_opt_in_required");
  }
  const resources=[];
  let destination;
  const stop=new AbortController();
  const stopSignals=["SIGINT","SIGTERM"];
  const onStop=()=>stop.abort();
  for(const name of stopSignals)process.once(name,onStop);
  try{
    // Validate every source BEFORE the first claim. Partially configured
    // multi-source execution fails closed, rather than silently skipping TG.
    const sources=[];
    for(const name of options.sources){
      const connection=sourceConnection(name,true);
      resources.push(connection);
      if(connection.kind==="pg")await checkPgOutbox(connection.connection);
      sources.push({name,connection,workerId:randomUUID()});
    }
    destination=destinationConnection();
    await checkDestination(destination);
    const report=event=>console.log(JSON.stringify({
      timestamp:new Date().toISOString(),...event,
    }));
    report({kind:"startup",sources:options.sources,mode:"foreground",
      perSourceClaimLimit:1,leaseMs:options.leaseMs});
    const executions=sources.map(async({name,connection,workerId})=>{
      try{
        return await runSourceLoop({
          source:name,signal:stop.signal,pollMs:options.pollMs,
          paceMs:options.paceMs,maxFailures:options.maxFailures,
          maxBatches:options.maxBatches,onReport:report,
          runBatch:()=>runDeliveryBatch(connection.port,destination,{
            workerId,batchSize:1,leaseMs:options.leaseMs,
          }),
        });
      }catch(error){
        stop.abort(); // all other source loops drain their active batch
        throw error;
      }
    });
    const results=await Promise.allSettled(executions);
    const failures=results.filter(result=>result.status==="rejected");
    for(const result of results)if(result.status==="fulfilled"){
      report({kind:"summary",...result.value});
    }
    if(failures.length){
      report({kind:"stopped",code:"source_failure_threshold_reached",failedSources:failures.length});
      process.exitCode=2;
    }else report({kind:"stopped",code:stop.signal.aborted?"signal":"bounded_run_complete"});
  }finally{
    stop.abort();
    for(const name of stopSignals)process.removeListener(name,onStop);
    if(destination)await destination.end();
    for(const connection of resources.reverse())await connection.close();
  }
}
const isEntrypoint=process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url;
if(isEntrypoint){
  main().catch(()=>{
    // Never print raw error/DSN/session/path in operator logs.
    console.error("intelligence supervisor failed: source_or_destination_operation_failed");
    process.exitCode=1;
  });
}
