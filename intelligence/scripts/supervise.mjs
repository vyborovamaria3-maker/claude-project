#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runDeliveryBatch } from "../dist/index.js";
import {
  sourceConnection, checkPgOutbox, checkDestination, destinationConnection, outboxStatus,
} from "./etl-connections.mjs";
import { runSourceLoop } from "./supervisor-core.mjs";
import { createAiRuntime } from "./ai-runtime.mjs";

/**
 * Foreground-only, laptop-local ETL process. Nothing runs unless explicitly
 * invoked with both opt-in gates and verified existing source/target schemas.
 * No source collection, browser sessions, MTProto, RPC or migrations.
 */
export function parseArguments(args){
  const options={
    sources:[],pollMs:2000,paceMs:100,leaseMs:120_000,maxFailures:5,
    maxBatches:0,healthIntervalMs:30_000,alertOldestPendingMs:300_000,help:false,
  };
  let provided=false;
  const numeric={
    "--poll-ms":["pollMs",100,60_000],
    "--pace-ms":["paceMs",0,60_000],
    "--lease-ms":["leaseMs",1000,3_600_000],
    "--max-failures":["maxFailures",1,100],
    "--max-batches":["maxBatches",0,1_000_000],
    "--health-interval-ms":["healthIntervalMs",1000,3_600_000],
    "--alert-oldest-pending-ms":["alertOldestPendingMs",0,86_400_000],
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
    "           --health-interval-ms 30000 --alert-oldest-pending-ms 300000",
    "  Health emits pending/ready/leased/retry/DLQ, oldest-pending lag and last progress.",
    "  Set --alert-oldest-pending-ms 0 to disable the oldest-pending age alert.",
    "  --max-batches N is a per-source upper bound; 0 means until SIGINT/SIGTERM.",
    "  Use --sources x or --sources tg,blockchain to run only configured sources.",
    "  X_SOURCE_DATABASE_URL, TG_SOURCE_DATABASE_URL, SOLANA_TRADE_DB_PATH",
    "  INTELLIGENCE_DATABASE_URL: separate target PostgreSQL with migrations 001+002+004.",
    "  Requires existing source outbox schemas; does NOT apply migrations.",
    "  Preserve separate producer opt-ins; never point this at live DBs before backup/restore.",
  ].join("\n");
}

export function classifyOutboxHealth(status,options={}){
  if(!status||!Number.isSafeInteger(status.pending)||status.pending<0||
     !Number.isSafeInteger(status.deadLetter)||status.deadLetter<0||
     !Number.isSafeInteger(status.maxAttempts)||status.maxAttempts<0||
     (status.oldestPendingAgeMs!==null&&
       (!Number.isSafeInteger(status.oldestPendingAgeMs)||status.oldestPendingAgeMs<0))){
    throw new TypeError("invalid outbox health snapshot");
  }
  const oldestPendingMs=options.alertOldestPendingMs??300_000;
  const maxFailures=options.maxFailures??5;
  if(!Number.isSafeInteger(oldestPendingMs)||oldestPendingMs<0||
     !Number.isSafeInteger(maxFailures)||maxFailures<1){
    throw new RangeError("invalid outbox health alert thresholds");
  }
  const alerts=[];
  if(status.deadLetter>0)alerts.push("dead_letter_events_present");
  if(oldestPendingMs>0&&status.oldestPendingAgeMs!==null&&
     status.oldestPendingAgeMs>oldestPendingMs){
    alerts.push("oldest_pending_age_exceeded");
  }
  if(status.pending>0&&status.maxAttempts>=maxFailures){
    alerts.push("pending_retry_threshold_exceeded");
  }
  return alerts;
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
    await checkDestination(destination,{requireBlockchainRevisions:options.sources.includes('blockchain')});
    const ai=await createAiRuntime(destination,Object.fromEntries(sources.filter(s=>s.connection.kind==='pg').map(s=>[s.name,s.connection.connection])));
    const report=event=>console.log(JSON.stringify({
      timestamp:new Date().toISOString(),...event,
    }));
    const emitHealth=async(name,connection)=>{
      const health=await outboxStatus(connection);
      report({kind:"health",source:name,...health});
      for(const code of classifyOutboxHealth(health,options)){
        report({kind:"alert",source:name,code,
          oldestPendingAgeMs:health.oldestPendingAgeMs,
          deadLetter:health.deadLetter,maxAttempts:health.maxAttempts});
      }
    };
    report({kind:"startup",sources:options.sources,mode:"foreground",
      perSourceClaimLimit:1,leaseMs:options.leaseMs,
      healthIntervalMs:options.healthIntervalMs,
      alertOldestPendingMs:options.alertOldestPendingMs});
    for(const source of sources)await emitHealth(source.name,source.connection);
    const executions=sources.map(async({name,connection,workerId})=>{
      let lastHealthAt=Date.now();
      try{
        return await runSourceLoop({
          source:name,signal:stop.signal,pollMs:options.pollMs,
          paceMs:options.paceMs,maxFailures:options.maxFailures,
          maxBatches:options.maxBatches,onReport:report,
          runBatch:async()=>{
            const stats=await runDeliveryBatch(connection.port,destination,{workerId,batchSize:1,leaseMs:options.leaseMs});
            if(Date.now()-lastHealthAt>=options.healthIntervalMs||stats.failed>0||stats.lostLeases>0){
              try{await emitHealth(name,connection);}
              catch{report({kind:"health",source:name,code:"health_probe_failed"});}
              lastHealthAt=Date.now();
            }
            if(ai&&name!=='blockchain'&&!stop.signal.aborted)try{report({kind:"ai",source:name,...(await ai.run(name,stop.signal))});}
            catch{report({kind:"ai",source:name,code:"ai_batch_failed"});}
            return stats;
          },
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
