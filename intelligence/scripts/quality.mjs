#!/usr/bin/env node
import {pathToFileURL} from "node:url";
import {resolve} from "node:path";
import {
  parseQualityArgs,normalizeOutboxCounters,inspectSourceSamples,
  loadCheckpointSummary,sourceHealth,buildQualityReport,formatQualityTable,
} from "./quality-core.mjs";
import {
  sourceConnection,checkPgOutbox,destinationConnection,checkDestination,
} from "./etl-connections.mjs";
import {sourceIdentity} from "./backfill.mjs";

const PG_QUEUE=[
  "SELECT COUNT(*)::text AS total,",
  "COUNT(*) FILTER(WHERE processed_at IS NULL AND dead_lettered_at IS NULL)::text AS pending,",
  "COUNT(*) FILTER(WHERE processed_at IS NULL AND dead_lettered_at IS NULL AND next_attempt_at<=NOW()",
  "AND (lease_until IS NULL OR lease_until<=NOW()))::text AS ready,",
  "COUNT(*) FILTER(WHERE processed_at IS NULL AND dead_lettered_at IS NULL AND lease_until>NOW())::text AS leased,",
  "COUNT(*) FILTER(WHERE processed_at IS NULL AND dead_lettered_at IS NULL AND attempts>0",
  "AND next_attempt_at>NOW())::text AS retry_delayed,",
  "COUNT(*) FILTER(WHERE dead_lettered_at IS NOT NULL)::text AS dead_letter,",
  "COUNT(*) FILTER(WHERE processed_at IS NOT NULL)::text AS processed,",
  "COUNT(*) FILTER(WHERE event_kind='token_link_verified')::text AS verified_links,",
  "COUNT(*) FILTER(WHERE event_kind='token_links_invalidated')::text AS invalidations,",
  "MIN(created_at) FILTER(WHERE processed_at IS NULL AND dead_lettered_at IS NULL) AS oldest_pending_at",
  "FROM outbox_events",
].join(" ");
const SQLITE_QUEUE=[
  "SELECT COUNT(*) AS total,",
  "COUNT(*) FILTER(WHERE processed_at IS NULL AND dead_lettered_at IS NULL) AS pending,",
  "COUNT(*) FILTER(WHERE processed_at IS NULL AND dead_lettered_at IS NULL AND next_attempt_at<=?",
  "AND (lease_until IS NULL OR lease_until<=?)) AS ready,",
  "COUNT(*) FILTER(WHERE processed_at IS NULL AND dead_lettered_at IS NULL AND lease_until>?) AS leased,",
  "COUNT(*) FILTER(WHERE processed_at IS NULL AND dead_lettered_at IS NULL AND attempts>0",
  "AND next_attempt_at>?) AS retry_delayed,",
  "COUNT(*) FILTER(WHERE dead_lettered_at IS NOT NULL) AS dead_letter,",
  "COUNT(*) FILTER(WHERE processed_at IS NOT NULL) AS processed,",
  "COUNT(*) FILTER(WHERE event_kind='token_link_verified') AS verified_links,",
  "COUNT(*) FILTER(WHERE event_kind='token_links_invalidated') AS invalidations,",
  "MIN(created_at) FILTER(WHERE processed_at IS NULL AND dead_lettered_at IS NULL) AS oldest_pending_at",
  "FROM outbox_events",
].join(" ");
const SAMPLE_X="SELECT tweet_id,author_id,updated_at,posted_at "+
  "FROM twitter_tweets ORDER BY char_length(tweet_id) DESC,tweet_id DESC LIMIT $1";
const SAMPLE_TG="SELECT m.message_id::text,s.peer_id,m.collected_at,m.deleted_at "+
  "FROM tg_messages m JOIN tg_sources s ON s.id=m.source_id "+
  "ORDER BY m.source_id DESC,m.message_id DESC LIMIT $1";
const SAMPLE_CHAIN="SELECT kind,address,signature,observed_at,payload_hash "+
  "FROM chain_seed_events ORDER BY observed_at DESC,signature DESC LIMIT ?";

/** All data access uses SELECT. No collector, RPC, migration or write mode. */
export async function readSourceQuality(source,opts,dependencies={}){
  let connection;
  try{
    connection=dependencies.connection??sourceConnection(source,false);
    if(connection.kind==="pg")await checkPgOutbox(connection.connection);
    const now=dependencies.now??new Date();
    let queueRow,rows;
    if(connection.kind==="pg"){
      const [queue,samples]=await Promise.all([
        connection.connection.query(PG_QUEUE),
        connection.connection.query(source==="x"?SAMPLE_X:SAMPLE_TG,[opts.sample]),
      ]);
      queueRow=queue.rows[0];rows=samples.rows;
    }else{
      const time=now.toISOString(),db=connection.connection;
      queueRow=db.prepare(SQLITE_QUEUE).get(time,time,time,time);
      rows=db.prepare(SAMPLE_CHAIN).all(opts.sample);
    }
    const output={
      status:"ok",
      queue:normalizeOutboxCounters(queueRow,now,opts.staleMinutes),
      sample:inspectSourceSamples(source,rows),
      completeness:{
        historical:"unknown",nativeHistoryComplete:null,
        processedBackfillCoverage:null,
        label:"source_sample_and_outbox_only",
      },
    };
    if(opts.checkpoints?.[source]){
      const identity=await (dependencies.sourceIdentity??sourceIdentity)(
        source,connection.connection);
      try{
        output.checkpoint=await loadCheckpointSummary(
          opts.checkpoints[source],source,identity,
        );
      }catch{
        output.checkpoint={state:"unavailable_or_mismatched",historyCompleteness:"unknown"};
      }
    }else output.checkpoint={state:"not_configured",historyCompleteness:"unknown"};
    output.health=sourceHealth(output);
    if(output.checkpoint.state==="unavailable_or_mismatched")output.health="attention";
    return output;
  }catch{
    // Never print DSN, original DB errors, file paths, texts or provider logs.
    return {status:"unavailable",health:"unavailable",
      errorCode:"source_schema_or_read_failed",
      completeness:{historical:"unknown"}};
  }finally{
    if(connection&&!dependencies.connection){
      try{await connection.close()}catch{/* no path leaks */}
    }
  }
}
export async function readDestinationQuality(sources,dependencies={}){
  let pool;
  try{
    pool=dependencies.pool??destinationConnection();
    await checkDestination(pool);
    const sourceMap=Object.fromEntries(sources.map(name=>[name,{
      ingested:0,timeline:0,tokenEvidence:0,verifiedLinkObservations:null,
      invalidationObservations:null,
    }]));
    const counts=await pool.query(
      "SELECT source_system,count(*)::text AS n FROM intelligence_inbox "+
      "WHERE source_system=ANY($1::text[]) GROUP BY source_system",[sources]);
    for(const row of counts.rows)if(sourceMap[row.source_system])
      sourceMap[row.source_system].ingested=Number(row.n);
    const timelines=await pool.query(
      "SELECT source_system,count(*)::text AS n FROM timeline_events "+
      "WHERE source_system=ANY($1::text[]) GROUP BY source_system",[sources]);
    for(const row of timelines.rows)if(sourceMap[row.source_system])
      sourceMap[row.source_system].timeline=Number(row.n);
    const tokenRows=await pool.query(
      "SELECT source_system,count(*)::text AS n FROM entity_evidence "+
      "WHERE kind='token' AND source_system=ANY($1::text[]) GROUP BY source_system",[sources]);
    for(const row of tokenRows.rows)if(sourceMap[row.source_system])
      sourceMap[row.source_system].tokenEvidence=Number(row.n);
    const hasLinks=await pool.query(
      "SELECT to_regclass('token_link_observations') IS NOT NULL AS present");
    if(hasLinks.rows[0]?.present){
      for(const entry of Object.values(sourceMap)){
        entry.verifiedLinkObservations=0;entry.invalidationObservations=0;
      }
      const links=await pool.query(
        "SELECT source_system,state,count(*)::text AS n "+
        "FROM token_link_observations WHERE source_system=ANY($1::text[]) "+
        "GROUP BY source_system,state",[sources]);
      for(const row of links.rows){
        const entry=sourceMap[row.source_system];
        if(!entry)continue;
        if(row.state==="verified")entry.verifiedLinkObservations=Number(row.n);
        if(row.state==="invalidated")entry.invalidationObservations=Number(row.n);
      }
    }
    return {
      status:"ok",sources:sourceMap,
      linkageNote:"counters_are_not_identical_to_native_history_coverage",
      migration004:!!hasLinks.rows[0]?.present,
    };
  }catch{
    return {status:"unavailable",errorCode:"destination_schema_or_read_failed"};
  }finally{
    if(pool&&!dependencies.pool){
      try{await pool.end()}catch{}
    }
  }
}
export async function collectQuality(options,dependencies={}){
  const observedAt=(dependencies.now??new Date()).toISOString();
  const results=await Promise.all(options.sources.map(async source=>{
    const injected=dependencies.connections?.[source];
    return [source,await readSourceQuality(source,options,{
      now:dependencies.now,connection:injected,
      sourceIdentity:dependencies.sourceIdentity,
    })];
  }));
  const target=options.target?await readDestinationQuality(options.sources,{
    pool:dependencies.destination,
  }):null;
  return buildQualityReport({
    sources:Object.fromEntries(results),target,observedAt,
    staleMinutes:options.staleMinutes,
  });
}
const usage=[
  "ARCH-09 data-quality report; read-only, bounded source samples; no RPC.",
  "node scripts/quality.mjs --sources x,tg,blockchain --format table",
  "node scripts/quality.mjs --sources tg --sample 100 --stale-minutes 60 --target",
  "node scripts/quality.mjs --sources x --checkpoint x=C:\\temp\\intelligence-backfill-x.json",
  "Options: --format json|table; --strict exits 2 on unavailable/attention.",
  "Source env: X_SOURCE_DATABASE_URL / TG_SOURCE_DATABASE_URL / SOLANA_TRADE_DB_PATH.",
  "Destination env: INTELLIGENCE_DATABASE_URL (only with --target).",
  "No dates, deleted revisions, on-chain finality or history completeness are inferred.",
].join("\n");
async function main(){
  const options=parseQualityArgs(process.argv.slice(2));
  if(options.help){console.log(usage);return;}
  const report=await collectQuality(options);
  console.log(options.format==="table"?formatQualityTable(report):JSON.stringify(report));
  if(options.strict&&report.status!=="observed")process.exitCode=2;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  main().catch(()=>{
    console.error("quality report failed: validation_or_read_failed");
    process.exitCode=1;
  });
}
