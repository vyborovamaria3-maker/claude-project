import {parseTokenId} from "@claude-project/contracts";
import {queryTokenTimeline,queryActiveTokenLinks} from "../dist/index.js";

const API_PREFIX="/api/intelligence/v1";
const UTC=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const PARAMS=new Set(["occurredBefore","knownAt","limit"]);
const SOURCES=new Set(["x","tg","blockchain"]);
const KINDS=new Set([
  "tweet_published","tg_message_published","chain_transaction",
  "trade_executed","signal_detected","signal_outcome",
]);
function timeParam(value,name){
  if(!value||!UTC.test(value))throw new TypeError("invalid_"+name);
  const date=new Date(value);
  if(!Number.isFinite(date.getTime())||date.toISOString()!==
     (value.includes(".") ? value.replace(/\.(\d{1,2})Z$/,(_,ms)=>"."+ms.padEnd(3,"0")+"Z") :
       value.replace(/Z$/,".000Z"))){
    throw new TypeError("invalid_"+name);
  }
  return date.toISOString();
}
function safeTime(value){
  const date=value instanceof Date?value:new Date(value);
  if(!Number.isFinite(date.getTime()))throw new TypeError("invalid_stored_date");
  return date.toISOString();
}
export function parseApiRequest(raw,now=new Date()){
  if(typeof raw!=="string"||raw.length>2048||!raw.startsWith("/")||
     raw.startsWith("//")||raw.includes("\\")||raw.includes("#")){
    throw new TypeError("invalid_request_target");
  }
  const url=new URL(raw,"http://127.0.0.1");
  if(url.origin!=="http://127.0.0.1")throw new TypeError("invalid_origin");
  if(url.pathname===API_PREFIX+"/health"){
    if(url.search)throw new TypeError("unexpected_query");
    return {kind:"health"};
  }
  const match=/^\/api\/intelligence\/v1\/tokens\/([^/]+)\/(timeline|links)$/.exec(url.pathname);
  if(!match)return null;
  let tokenId;
  try{tokenId=decodeURIComponent(match[1]);}
  catch{throw new TypeError("invalid_token_id");}
  // v1 deliberately only exposes verified Solana mint IDs, not arbitrary
  // wallet IDs, author IDs or ticker aliases.
  if(!tokenId.startsWith("solana:")||
     parseTokenId(tokenId)?.id!==tokenId ||
     !["solana",...[]].includes(tokenId.slice(0,6))){
    throw new TypeError("invalid_token_id");
  }
  const query=url.searchParams;
  for(const key of query.keys()){
    if(!PARAMS.has(key)||query.getAll(key).length!==1)
      throw new TypeError("invalid_query");
  }
  const occurredBefore=timeParam(query.get("occurredBefore"),"occurredBefore");
  const knownAt=timeParam(query.get("knownAt"),"knownAt");
  if(occurredBefore>knownAt||knownAt>safeTime(now))throw new TypeError("invalid_time_window");
  const rawLimit=query.get("limit")??"50";
  if(!/^[1-9][0-9]*$/.test(rawLimit)||
      Number(rawLimit)>100)throw new TypeError("invalid_limit");
  return {
    kind:match[2],tokenId,occurredBefore,knownAt,
    limit:Number(rawLimit),
  };
}
function responseBase(query,items,truncated){
  return {
    schemaVersion:"token-intelligence-v1",
    tokenId:query.tokenId,
    occurredBefore:query.occurredBefore,
    knownAt:query.knownAt,
    historicalCompleteness:"unknown",
    coverage:"observed_and_qualified_events_only",
    truncated,
    items,
  };
}
function safeSource(v){
  if(typeof v!=="string"||!SOURCES.has(v))throw new TypeError("invalid_source");
  return v;
}
function safeEvidenceId(v){
  if(typeof v!=="string"||v.length>256||
      !/^(?:x:tweet:|tg:message:|chain:tx:)[A-Za-z0-9:_-]+$/.test(v))
    throw new TypeError("invalid_source_evidence");
  return v;
}
function normalizeTimeline(row){
  if(!KINDS.has(row.timeline_kind))throw new TypeError("invalid_timeline_kind");
  return {
    source:safeSource(row.source_system),
    kind:row.timeline_kind,
    evidenceId:safeEvidenceId(row.evidence_source_id),
    occurredAt:safeTime(row.occurred_at),
    observedAt:safeTime(row.observed_at),
  };
}
function normalizeLink(row,tokenId){
  if(!["x","tg"].includes(row.source_system))throw new TypeError("invalid_link_source");
  if(row.canonical_token_id!==tokenId)throw new TypeError("invalid_link_attribution");
  return {
    source:row.source_system,
    evidenceId:safeEvidenceId(row.evidence_source_id),
    occurredAt:row.occurred_at===null?null:safeTime(row.occurred_at),
    observedAt:safeTime(row.observed_at),
    verification:"source_verified_spl_mint_account",
    // Intentionally do not publish details, revision hash, provider request,
    // source content, raw timeline payload, event keys or private DSNs.
  };
}
export async function queryTokenApi(pool,request){
  if(request.kind==="health"){
    await pool.query("SELECT 1 AS ok");
    return {
      schemaVersion:"token-intelligence-v1",
      status:"available",
      scope:"intelligence_destination_database_only",
      sourceCollectorsChecked:false,
      historicalCompleteness:"unknown",
    };
  }
  if(request.kind==="timeline"){
    const records=await queryTokenTimeline(
      pool,request.tokenId,request.occurredBefore,request.knownAt,request.limit+1,
    );
    const items=records.slice(0,request.limit).map(normalizeTimeline);
    return responseBase(request,items,records.length>request.limit);
  }
  if(request.kind==="links"){
    const records=await queryActiveTokenLinks(
      pool,request.tokenId,request.occurredBefore,request.knownAt,request.limit+1,
    );
    const items=records.slice(0,request.limit).map(row=>normalizeLink(row,request.tokenId));
    return {...responseBase(request,items,records.length>request.limit),
      linkState:"active_as_known_at",
      editDeleteCoverage:"not_guaranteed_for_legacy_source_history"};
  }
  throw new TypeError("invalid_api_route");
}
