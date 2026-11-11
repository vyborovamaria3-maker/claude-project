#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
  sourceConnection, checkPgOutbox, checkDestination, destinationConnection, outboxStatus,
} from "./etl-connections.mjs";
import { runDeliveryBatch } from "../dist/index.js";
import { createAiRuntime } from "./ai-runtime.mjs";

/**
 * Explicit, bounded local ETL command. No background service or automatic
 * source migrations. Does not connect to X/Telegram platforms or Solana RPC.
 */
function argumentsFor(argv) {
  const options={source:null,once:false,status:false,limit:50,help:false};
  for(let i=0;i<argv.length;i++){
    const arg=argv[i];
    if(arg==="--help"||arg==="-h") options.help=true;
    else if(arg==="--once") options.once=true;
    else if(arg==="--status") options.status=true;
    else if(arg==="--source"){
      options.source=argv[++i];
    }else if(arg.startsWith("--source=")){
      options.source=arg.slice("--source=".length);
    }else if(arg==="--limit"){
      options.limit=Number(argv[++i]);
    }else if(arg.startsWith("--limit=")){
      options.limit=Number(arg.slice("--limit=".length));
    }else throw new Error("unknown CLI option");
  }
  if(options.help)return options;
  if(!["x","tg","blockchain"].includes(options.source)) throw new Error("select --source x|tg|blockchain");
  if(options.once===options.status) throw new Error("select exactly one of --once or --status");
  if(!Number.isSafeInteger(options.limit)||options.limit<1||options.limit>1000)throw new Error("limit must be 1..1000");
  return options;
}
function usage() {
  return [
    "Intelligence local ETL (no source or remote collection is started)",
    "  node scripts/run.mjs --source x|tg|blockchain --status",
    "  INTELLIGENCE_ETL_ENABLED=true node scripts/run.mjs --source x|tg|blockchain --once --limit 50",
    "Source env: X_SOURCE_DATABASE_URL, TG_SOURCE_DATABASE_URL, SOLANA_TRADE_DB_PATH",
    "Destination env: INTELLIGENCE_DATABASE_URL (required for --once)",
    "Preconditions: source outbox schema, destination 001+002+004; +005 for Blockchain swap revisions",
  ].join("\n");
}
async function main(){
  const args=argumentsFor(process.argv.slice(2));
  if(args.help){console.log(usage());return;}
  if(args.once && process.env.INTELLIGENCE_ETL_ENABLED!=="true"){
    throw new Error("set INTELLIGENCE_ETL_ENABLED=true for explicit delivery");
  }
  const source=sourceConnection(args.source,args.once);
  let destination;
  try{
    if(args.status){
      console.log(JSON.stringify({source:args.source,mode:"status",...(await outboxStatus(source))}));
      return;
    }
    if(source.kind==="pg")await checkPgOutbox(source.connection);
    destination=destinationConnection();
    await checkDestination(destination,{requireBlockchainRevisions:args.source==='blockchain'});
    const ai=await createAiRuntime(destination,source.kind==='pg'?{[args.source]:source.connection}:{});
    const stats=await runDeliveryBatch(source.port,destination,{
      workerId:randomUUID(),batchSize:args.limit,leaseMs:120_000,
    });
    console.log(JSON.stringify({source:args.source,mode:"once",...stats}));
    if(ai&&args.source!=='blockchain'){
      try{
        const result=await ai.run(args.source);
        console.log(JSON.stringify({source:args.source,mode:"ai",...result}));
        if(result?.failed||result?.refreshFailed)process.exitCode=2;
      }
      catch{console.error("ai_batch_failed");process.exitCode=2;}
    }
    if(stats.failed>0||stats.lostLeases>0)process.exitCode=2;
  }finally{
    if(destination)await destination.end();
    await source.close();
  }
}
main().catch(error=>{
  // Error strings/URLs can carry source account/database credentials.
  // Only a bounded, nonsecret error classification is printed.
  const allowlisted = error instanceof Error && (
    error.message === "set INTELLIGENCE_ETL_ENABLED=true for explicit delivery" ||
    /^(select exactly one|select --source|limit must|unknown CLI option)/.test(error.message)
  );
  console.error("intelligence ETL failed:", allowlisted ? error.message : "source_or_destination_operation_failed");
  process.exitCode=1;
});
