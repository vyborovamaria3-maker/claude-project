import {parseTokenId} from "@claude-project/contracts";
import {queryTokenTimeline,queryActiveTokenLinks,queryActiveBlockchainSwapEvidence} from "../dist/index.js";

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
  const nowIso=safeTime(now);
  const globalMatch=/^\/api\/intelligence\/v1\/(signals|backtest)$/.exec(url.pathname);
  if(globalMatch){
    const kind=globalMatch[1];
    const allowed=kind==="signals"?new Set(["asOf","limit"]):new Set(["signal","limit"]);
    const query=url.searchParams;
    for(const key of query.keys()){
      if(!allowed.has(key)||query.getAll(key).length!==1)throw new TypeError("invalid_query");
    }
    const rawLimit=query.get("limit")??"50";
    if(!/^[1-9][0-9]*$/.test(rawLimit)||Number(rawLimit)>100)throw new TypeError("invalid_limit");
    if(kind==="signals"){
      const asOf=timeParam(query.get("asOf"),"asOf");
      if(asOf>nowIso)throw new TypeError("invalid_time_window");
      return {kind,asOf,limit:Number(rawLimit)};
    }
    const signal=query.get("signal");
    if(signal!==null&&!/^[a-z][a-z0-9_]{0,63}$/.test(signal))throw new TypeError("invalid_signal");
    return {kind,signal,limit:Number(rawLimit)};
  }
  const match=/^\/api\/intelligence\/v1\/tokens\/([^/]+)\/(timeline|links|swap-evidence|summary|features|correlations)$/.exec(url.pathname);
  if(!match)return null;
  let tokenId;
  try{tokenId=decodeURIComponent(match[1]);}
  catch{throw new TypeError("invalid_token_id");}
  if(!tokenId.startsWith("solana:")||parseTokenId(tokenId)?.id!==tokenId){
    throw new TypeError("invalid_token_id");
  }
  const kind=match[2];
  const query=url.searchParams;
  const legacy=new Set(["timeline","links","swap-evidence"]);
  const allowed=legacy
    ? (legacy.has(kind)?new Set(["occurredBefore","knownAt","limit"]):new Set(["asOf","limit"]))
    : new Set();
  const routeAllowed=legacy.has(kind)
    ? new Set(["occurredBefore","knownAt","limit"])
    : kind==="correlations" ? new Set(["asOf","limit"]) : new Set(["asOf"]);
  for(const key of query.keys()){
    if(!routeAllowed.has(key)||query.getAll(key).length!==1)throw new TypeError("invalid_query");
  }
  const rawLimit=query.get("limit")??"50";
  if(!/^[1-9][0-9]*$/.test(rawLimit)||Number(rawLimit)>100)throw new TypeError("invalid_limit");
  if(legacy.has(kind)){
    const occurredBefore=timeParam(query.get("occurredBefore"),"occurredBefore");
    const knownAt=timeParam(query.get("knownAt"),"knownAt");
    if(occurredBefore>knownAt||knownAt>nowIso)throw new TypeError("invalid_time_window");
    return {kind,tokenId,occurredBefore,knownAt,limit:Number(rawLimit)};
  }
  const asOf=timeParam(query.get("asOf"),"asOf");
  if(asOf>nowIso)throw new TypeError("invalid_time_window");
  return {kind,tokenId,asOf,limit:Number(rawLimit)};
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
function normalizeSwapEvidence(row,tokenId){
  if(row.canonical_token_id!==tokenId||typeof row.signature!=="string")
    throw new TypeError("invalid_swap_token_attribution");
  if(!Number.isSafeInteger(Number(row.slot))||Number(row.slot)<=0)
    throw new TypeError("invalid_swap_slot");
  return {
    source:"blockchain",kind:"chain_transaction",
    evidenceId:safeEvidenceId("chain:tx:solana:"+row.signature),
    occurredAt:safeTime(row.occurred_at),observedAt:safeTime(row.observed_at),
    attribution:"provider_parsed_wallet_swap",
    finality:"not_independently_verified",
    evidenceStatus:"current_source_revision_as_known_at",
    tradeCompleteness:"unknown",
  };
}
function numberOrNull(value){
  if(value===null||value===undefined)return null;
  const parsed=typeof value==="number"?value:Number(value);
  return Number.isFinite(parsed)?parsed:null;
}
function safeObject(value){
  return value&&typeof value==="object"&&!Array.isArray(value)?value:{};
}
function safeRefs(value){
  if(!Array.isArray(value))return [];
  const result=[];
  for(const item of value){
    try{result.push(safeEvidenceId(item));}catch{}
    if(result.length>=100)break;
  }
  return [...new Set(result)];
}
const FEATURE_KEYS=new Set([
  "mentions_5m","mentions_15m","mentions_1h","unique_authors","unique_sources","velocity","acceleration",
  "sentiment_bullish_ratio","bot_ratio","smart_money_bought_at","liquidity_usd","volume_24h_usd",
  "holder_concentration","decoder_coverage","history_coverage","data_confidence","sentiment_score",
  "copypasta_ratio","narrative_id","velocity_5m","velocity_1h","embedding_ref","cluster_id","coherence_score",
]);
function safeFeatures(value){
  const source=safeObject(value);
  const result={};
  for(const [key,item] of Object.entries(source)){
    if(!FEATURE_KEYS.has(key))continue;
    if(item===null||typeof item==="string"||typeof item==="boolean"||
       (typeof item==="number"&&Number.isFinite(item)))result[key]=item;
  }
  return result;
}
function safeCoverage(value){
  const source=safeObject(value);
  const normalize=(item)=>["complete","partial","unknown"].includes(item)?item:"unknown";
  return {tg:normalize(source.tg),x:normalize(source.x),blockchain:normalize(source.blockchain)};
}
function normalizeSummary(row,request){
  return {
    schemaVersion:"token-intelligence-v1",tokenId:request.tokenId,asOf:safeTime(row.as_of),
    maxInputObservedAt:safeTime(row.max_input_observed_at),
    historicalCompleteness:"unknown",dataAvailable:true,
    metrics:{
      tgMentions:numberOrNull(row.tg_mentions),tgUniqueAuthors:numberOrNull(row.tg_unique_authors),
      tgCopypastaRatio:numberOrNull(row.tg_copypasta_ratio),tgSentimentScore:numberOrNull(row.tg_sentiment_score),
      tgScamRatio:numberOrNull(row.tg_scam_ratio),xMentions:numberOrNull(row.x_mentions),
      xUniqueAuthors:numberOrNull(row.x_unique_authors),xBotRatio:numberOrNull(row.x_bot_ratio),
      xSentimentScore:numberOrNull(row.x_sentiment_score),chainTrades:numberOrNull(row.chain_trades),
      chainUniqueWallets:numberOrNull(row.chain_unique_wallets),chainVolumeUsd:numberOrNull(row.chain_volume_usd),
      chainLiquidityUsd:numberOrNull(row.chain_liquidity_usd),chainSmartMoneyBought:numberOrNull(row.chain_smart_money_bought),
      chainRugRisk:numberOrNull(row.chain_rug_risk),
    },
    firstMentionTgAt:row.first_mention_tg_at===null?null:safeTime(row.first_mention_tg_at),
    firstMentionXAt:row.first_mention_x_at===null?null:safeTime(row.first_mention_x_at),
    firstTradeAt:row.first_trade_at===null?null:safeTime(row.first_trade_at),
    scores:{
      attention:numberOrNull(row.attention_score),credibility:numberOrNull(row.credibility_score),
      risk:numberOrNull(row.risk_score),momentum:numberOrNull(row.momentum_score),
      version:typeof row.score_version==="string"?row.score_version:null,
      reason:safeObject(row.score_reason),
    },
    dataConfidence:numberOrNull(row.data_confidence),
    sourceCoverage:safeCoverage(row.source_coverage),
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
  if(request.kind==="swap-evidence"){
    const records=await queryActiveBlockchainSwapEvidence(
      pool,request.tokenId,request.occurredBefore,request.knownAt,request.limit+1,
    );
    const items=records.slice(0,request.limit)
      .map(row=>normalizeSwapEvidence(row,request.tokenId));
    return {...responseBase(request,items,records.length>request.limit),
      evidenceScope:"current_wallet_revision_agreement_only",
      mintVerification:"not_independently_verified",
      tradeStatus:"not_a_confirmed_trade_tape"};
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
  if(request.kind==="summary"){
    const result=await pool.query(`SELECT * FROM token_daily_cross_platform
      WHERE canonical_token_id=$1 AND as_of <= $2 AND max_input_observed_at <= $2
      ORDER BY as_of DESC LIMIT 1`,[request.tokenId,request.asOf]);
    if(!result.rows.length)return {
      schemaVersion:"token-intelligence-v1",tokenId:request.tokenId,asOf:request.asOf,
      dataAvailable:false,historicalCompleteness:"unknown",sourceCoverage:{tg:"unknown",x:"unknown",blockchain:"unknown"},
    };
    return normalizeSummary(result.rows[0],request);
  }
  if(request.kind==="features"){
    const result=await pool.query(`SELECT canonical_token_id,as_of,max_input_observed_at,feature_version,features
      FROM chain_token_features WHERE canonical_token_id=$1 AND as_of <= $2 AND max_input_observed_at <= $2
      ORDER BY as_of DESC,CASE feature_version WHEN 'features-v3' THEN 3 WHEN 'features-v2' THEN 2 ELSE 1 END DESC
      LIMIT 1`,[request.tokenId,request.asOf]);
    const row=result.rows[0];
    if(!row)return {schemaVersion:"token-intelligence-v1",tokenId:request.tokenId,asOf:request.asOf,dataAvailable:false};
    return {
      schemaVersion:"token-intelligence-v1",tokenId:request.tokenId,
      asOf:safeTime(row.as_of),maxInputObservedAt:safeTime(row.max_input_observed_at),
      featureVersion:row.feature_version,features:safeFeatures(row.features),dataAvailable:true,
    };
  }
  if(request.kind==="correlations"){
    const result=await pool.query(`SELECT event_kind,event_at,outcome_kind,outcome_at,lift,ci_low,ci_high,p_value,
      baseline,sample_size,evaluated_at,data_cutoff_at,model_id
      FROM token_correlations WHERE canonical_token_id=$1 AND evaluated_at <= $2
      ORDER BY p_value ASC NULLS LAST,evaluated_at DESC LIMIT $3`,
    [request.tokenId,request.asOf,request.limit+1]);
    const items=result.rows.slice(0,request.limit).map((row)=>({
      eventKind:String(row.event_kind),eventAt:safeTime(row.event_at),outcomeKind:String(row.outcome_kind),
      outcomeAt:row.outcome_at===null?null:safeTime(row.outcome_at),lift:numberOrNull(row.lift),
      ciLow:numberOrNull(row.ci_low),ciHigh:numberOrNull(row.ci_high),pValue:numberOrNull(row.p_value),
      baseline:safeObject(row.baseline),sampleSize:numberOrNull(row.sample_size),
      evaluatedAt:safeTime(row.evaluated_at),dataCutoffAt:safeTime(row.data_cutoff_at),
      modelId:typeof row.model_id==="string"?row.model_id:null,
    }));
    return {schemaVersion:"token-intelligence-v1",tokenId:request.tokenId,asOf:request.asOf,
      historicalCompleteness:"unknown",truncated:result.rows.length>request.limit,items};
  }
  if(request.kind==="signals"){
    const result=await pool.query(`SELECT alert_id,canonical_token_id,alert_type,severity,triggered_at,as_of,
      score,score_version,evidence_refs,status
      FROM token_alerts WHERE triggered_at <= $1 AND status <> 'resolved'
      ORDER BY triggered_at DESC LIMIT $2`,[request.asOf,request.limit+1]);
    const items=result.rows.slice(0,request.limit).map((row)=>({
      alertId:String(row.alert_id),tokenId:String(row.canonical_token_id),alertType:String(row.alert_type),
      severity:String(row.severity),triggeredAt:safeTime(row.triggered_at),asOf:safeTime(row.as_of),
      score:numberOrNull(row.score),scoreVersion:typeof row.score_version==="string"?row.score_version:null,
      evidenceRefs:safeRefs(row.evidence_refs),status:String(row.status),
    }));
    return {schemaVersion:"token-intelligence-v1",asOf:request.asOf,historicalCompleteness:"unknown",
      truncated:result.rows.length>request.limit,items};
  }
  if(request.kind==="backtest"){
    const result=await pool.query(`SELECT run_id,signal_name,outcome_kind,from_at,to_at,horizon_hours,threshold,
      baseline_kind,status,metrics,started_at,completed_at,data_cutoff_at,feature_version,model_id
      FROM backtest_runs WHERE status='completed' AND completed_at <= NOW()
        AND ($1::text IS NULL OR signal_name=$1)
      ORDER BY completed_at DESC LIMIT $2`,[request.signal,request.limit+1]);
    const items=result.rows.slice(0,request.limit).map((row)=>({
      runId:String(row.run_id),signal:String(row.signal_name),outcome:String(row.outcome_kind),
      fromAt:safeTime(row.from_at),toAt:safeTime(row.to_at),horizonHours:numberOrNull(row.horizon_hours),
      threshold:numberOrNull(row.threshold),baseline:String(row.baseline_kind),status:String(row.status),
      metrics:safeObject(row.metrics),startedAt:safeTime(row.started_at),
      completedAt:safeTime(row.completed_at),dataCutoffAt:row.data_cutoff_at===null?null:safeTime(row.data_cutoff_at),
      featureVersion:typeof row.feature_version==="string"?row.feature_version:null,
      modelId:typeof row.model_id==="string"?row.model_id:null,
    }));
    return {schemaVersion:"token-intelligence-v1",historicalCompleteness:"unknown",
      truncated:result.rows.length>request.limit,items};
  }
  throw new TypeError("invalid_api_route");
}
