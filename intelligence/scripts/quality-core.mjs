import {readFile} from "node:fs/promises";
import {validateCheckpoint} from "./backfill-core.mjs";

export const SOURCE_NAMES=["x","tg","blockchain"];
const NUMERIC=/^[1-9][0-9]{0,24}$/;
const TG_PEER=/^-?[1-9][0-9]{0,19}$/;
const BASE58=/^[1-9A-HJ-NP-Za-km-z]+$/;
const HASH=/^[a-f0-9]{64}$/;

export function parseQualityArgs(argv){
  const options={
    sources:[...SOURCE_NAMES],sample:200,staleMinutes:60,
    target:false,strict:false,format:"json",checkpoints:{},help:false,
  };
  const seen=new Set();
  for(let i=0;i<argv.length;i++){
    const split=argv[i].indexOf("=");
    const name=split<0?argv[i]:argv[i].slice(0,split);
    const inline=split<0?undefined:argv[i].slice(split+1);
    if(name==="--help"||name==="-h"){options.help=true;continue;}
    if(name==="--target"||name==="--strict"){
      if(inline!==undefined||seen.has(name))throw new TypeError("invalid quality flag");
      options[name==="--target"?"target":"strict"]=true;seen.add(name);continue;
    }
    if(!["--sources","--sample","--stale-minutes","--format","--checkpoint"].includes(name)){
      throw new TypeError("unknown quality option");
    }
    if(name!=="--checkpoint"&&seen.has(name))throw new TypeError("duplicate quality option");
    seen.add(name);
    const value=inline??argv[++i];
    if(!value)throw new TypeError("missing quality value");
    if(name==="--sources"){
      const list=value.split(",");
      if(!list.length||new Set(list).size!==list.length||
         list.some(s=>!SOURCE_NAMES.includes(s)))throw new TypeError("invalid source selection");
      options.sources=list;
    }else if(name==="--sample"||name==="--stale-minutes"){
      if(!/^[1-9][0-9]*$/.test(value)||Number(value)>1000&&name==="--sample"||
         Number(value)>1440&&name==="--stale-minutes"){
        throw new RangeError("quality sample 1..1000; stale minutes 1..1440");
      }
      options[name==="--sample"?"sample":"staleMinutes"]=Number(value);
    }else if(name==="--format"){
      if(!["json","table"].includes(value))throw new TypeError("invalid quality output format");
      options.format=value;
    }else{
      const equal=value.indexOf("=");
      const source=equal>0?value.slice(0,equal):"";
      const path=value.slice(equal+1);
      if(!SOURCE_NAMES.includes(source)||!path||options.checkpoints[source])
        throw new TypeError("checkpoint must be SOURCE=FILE");
      options.checkpoints[source]=path;
    }
  }
  for(const source of Object.keys(options.checkpoints)){
    if(!options.sources.includes(source))throw new TypeError("checkpoint source is not selected");
  }
  return options;
}
function saneCount(value){
  const n=typeof value==="string"&&/^[0-9]+$/.test(value)?Number(value):value;
  if(!Number.isSafeInteger(n)||n<0)throw new TypeError("unsafe count");
  return n;
}
export function normalizeOutboxCounters(row,now,staleMinutes){
  if(!row||typeof row!=="object")throw new TypeError("invalid queue counters");
  const result={};
  for(const key of ["total","pending","ready","leased","retry_delayed",
    "dead_letter","processed","verified_links","invalidations"]){
    result[key==="retry_delayed"?"retryDelayed":
      key==="dead_letter"?"deadLetter":
      key==="verified_links"?"verifiedLinks":
      key==="invalidations"?"invalidations":key]=saneCount(row[key]??0);
  }
  const oldest=row.oldest_pending_at;
  const parsed=oldest===null||oldest===undefined?null:new Date(oldest);
  if(parsed!==null&&!Number.isFinite(parsed.getTime()))throw new TypeError("invalid queue timestamp");
  result.oldestPendingAt=parsed?.toISOString()??null;
  result.oldestPendingMinutes=parsed===null?null:
    Math.max(0,Math.round((now.getTime()-parsed.getTime())/60000));
  result.stale=!!(result.pending>0&&result.oldestPendingMinutes!==null&&
    result.oldestPendingMinutes>staleMinutes);
  result.countsConsistent=result.total===result.processed+result.pending+result.deadLetter;
  // pending includes leased and not-yet-ready. The subcategories overlap;
  // do NOT sum ready + leased + retryDelayed as mutually exclusive.
  return result;
}
export function inspectSourceSamples(source,rows){
  if(!SOURCE_NAMES.includes(source)||!Array.isArray(rows))throw new TypeError("unknown sample source");
  const counts={examined:0,candidateEligible:0,excluded:0,reasons:{}};
  function exclude(reason){
    counts.excluded++;
    counts.reasons[reason]=(counts.reasons[reason]??0)+1;
  }
  for(const row of rows){
    counts.examined++;
    if(source==="x"){
      if(!NUMERIC.test(row.tweet_id??""))exclude("invalidTweetId");
      else if(!NUMERIC.test(row.author_id??""))exclude("missingStableAuthorId");
      else if(!Number.isSafeInteger(Number(row.updated_at))||
              Number(row.updated_at)<0||
              !Number.isFinite(new Date(Number(row.updated_at)).getTime()))
        exclude("invalidObservationClock");
      else counts.candidateEligible++;
    }else if(source==="tg"){
      if(!TG_PEER.test(row.peer_id??""))exclude("missingStablePeerId");
      else if(!NUMERIC.test(String(row.message_id??"")))exclude("invalidMessageId");
      else if(row.deleted_at!==null&&row.deleted_at!==undefined)exclude("deletedSnapshot");
      else if(row.collected_at===null||!Number.isFinite(new Date(row.collected_at).getTime()))
        exclude("invalidObservationClock");
      else counts.candidateEligible++;
    }else{
      if(row.kind!=="wallet")exclude("notWalletTarget");
      else if(!BASE58.test(row.address??"")||row.address.length<32||row.address.length>44)
        exclude("invalidAddressShape");
      else if(!BASE58.test(row.signature??"")||row.signature.length<64||row.signature.length>90)
        exclude("invalidSignatureShape");
      else if(!HASH.test(row.payload_hash??""))exclude("missingRawPayloadHash");
      else if(!Number.isSafeInteger(row.observed_at)||row.observed_at<0)
        exclude("invalidObservationClock");
      else counts.candidateEligible++;
    }
  }
  // Shape-only eligibility, never proof of a canonical token, wallet owner,
  // full history, or that source backfill completed.
  return {...counts,sampleOrder:"latest_source_key_or_observation",
    sampling:"bounded_nonrepresentative",historicalCoverage:"unknown"};
}
export async function loadCheckpointSummary(path,source,identity){
  const value=JSON.parse(await readFile(path,"utf8"));
  const verified=validateCheckpoint(value,source,value.scope,identity);
  return {state:"verified_for_database",visited:verified.visited,
    inserted:verified.inserted,duplicates:verified.duplicates,
    excluded:verified.excluded,boundedScanComplete:verified.complete,
    historyCompleteness:"unknown"};
}
export function sourceHealth(entry){
  if(entry.status!=="ok")return "unavailable";
  const {queue,sample}=entry;
  // An empty source or source snapshots with no Outbox output cannot prove
  // collection/delivery health. Avoid a misleading green "all clear".
  if((sample.examined===0&&queue.total===0)||
     (sample.examined>0&&queue.total===0)||
     !queue.countsConsistent||queue.deadLetter>0||queue.stale||
     sample.excluded>0)return "attention";
  return "observed";
}
export function buildQualityReport({sources,target=null,observedAt,staleMinutes}){
  const output={
    schemaVersion:"data-quality-v1",observedAt,
    status:"observed",
    historicalCompleteness:"unknown",
    sourceSnapshotsNotFullHistory:true,
    staleThresholdMinutes:staleMinutes,
    sources, ...(target===null?{destination:{status:"not_requested"}}:{destination:target}),
  };
  if(Object.values(sources).some(s=>s.health==="unavailable")||
     target?.status==="unavailable")output.status="unavailable";
  else if(Object.values(sources).some(s=>s.health==="attention"))output.status="attention";
  return output;
}
export function formatQualityTable(report){
  const rows=[
    "ARCH-09  | "+report.observedAt+" | "+report.status.toUpperCase(),
    "SOURCE      QUEUE    READY   RETRY  DLQ   OLDEST(min) SAMPLE(EXCL) HEALTH",
  ];
  for(const [source,v] of Object.entries(report.sources)){
    if(v.status!=="ok"){
      rows.push(source.padEnd(11)+"UNAVAILABLE (no source data read)");
      continue;
    }
    const q=v.queue;
    rows.push(source.padEnd(11)+
      String(q.pending).padStart(5)+"   "+String(q.ready).padStart(5)+
      "   "+String(q.retryDelayed).padStart(5)+
      "   "+String(q.deadLetter).padStart(3)+"   "+
      String(q.oldestPendingMinutes??"-").padStart(10)+" "+
      (v.sample.examined+"/"+v.sample.excluded).padStart(11)+" "+v.health);
  }
  rows.push("History completeness: UNKNOWN. Samples are not full coverage.");
  rows.push("Destination: "+report.destination.status);
  return rows.join("\n");
}
