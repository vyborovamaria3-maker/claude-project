#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
  sourceConnection, checkPgOutbox, checkDestination, destinationConnection,
} from "./etl-connections.mjs";
import { runDeliveryBatch } from "../dist/index.js";

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
    "Preconditions: source outbox schema and destination migrations 001+002+004",
  ].join("\n");
}
async function status(source){
  const at=new Date().toISOString();
  let row;
  if(source.kind==="sqlite"){
    row=source.connection.prepare(`SELECT
      count(*) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL) AS pending,
      count(*) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL
        AND next_attempt_at<=? AND (lease_until IS NULL OR lease_until<=?)) AS ready,
      count(*) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL
        AND lease_until>?) AS leased,
      count(*) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL
        AND attempts>0 AND next_attempt_at>?) AS retry_delayed,
      count(*) FILTER (WHERE dead_lettered_at IS NOT NULL) AS dead_letter,
      min(created_at) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL) AS oldest_pending_at,
      max(attempts) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL) AS max_attempts
    FROM outbox_events`).get(at,at,at,at);
  }else{
    await checkPgOutbox(source.connection);
    const result=await source.connection.query(`SELECT
      count(*) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL)::text AS pending,
      count(*) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL
        AND next_attempt_at<=$1::timestamptz
        AND (lease_until IS NULL OR lease_until<=$1::timestamptz))::text AS ready,
      count(*) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL
        AND lease_until>$1::timestamptz)::text AS leased,
      count(*) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL
        AND attempts>0 AND next_attempt_at>$1::timestamptz)::text AS retry_delayed,
      count(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::text AS dead_letter,
      min(created_at) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL) AS oldest_pending_at,
      max(attempts) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL)::text AS max_attempts
    FROM outbox_events`,[at]);
    row=result.rows[0];
  }
  return {
    pending:Number(row.pending),ready:Number(row.ready),
    leased:Number(row.leased),retryDelayed:Number(row.retry_delayed),
    deadLetter:Number(row.dead_letter),
    oldestPendingAt:row.oldest_pending_at===null?null:new Date(row.oldest_pending_at).toISOString(),
    maxAttempts:row.max_attempts===null?0:Number(row.max_attempts),
  };
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
      console.log(JSON.stringify({source:args.source,mode:"status",...(await status(source))}));
      return;
    }
    if(source.kind==="pg")await checkPgOutbox(source.connection);
    destination=destinationConnection();
    await checkDestination(destination);
    const stats=await runDeliveryBatch(source.port,destination,{
      workerId:randomUUID(),batchSize:args.limit,leaseMs:120_000,
    });
    console.log(JSON.stringify({source:args.source,mode:"once",...stats}));
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
