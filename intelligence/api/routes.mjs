import {parseTokenId} from "@claude-project/contracts";
import {aiDataCatalog,queryAiTokenContext} from "./ai-context.mjs";
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
  if(url.pathname===API_PREFIX+"/ai/catalog"){
    if(url.search)throw new TypeError("unexpected_query");
    return {kind:"ai-catalog"};
  }
  const nowIso=safeTime(now);
  const globalMatch=/^\/api\/intelligence\/v1\/(signals|backtest|ai)$/.exec(url.pathname);
  if(globalMatch){
    const kind=globalMatch[1];
    const allowed=kind==="ai"?new Set(["asOf","limit","source"]):kind==="signals"?new Set(["asOf","limit"]):new Set(["signal","limit"]);
    const query=url.searchParams;
    for(const key of query.keys()){
      if(!allowed.has(key)||query.getAll(key).length!==1)throw new TypeError("invalid_query");
    }
    const rawLimit=query.get("limit")??"50";
    if(!/^[1-9][0-9]*$/.test(rawLimit)||Number(rawLimit)>100)throw new TypeError("invalid_limit");
    if(kind==="signals"||kind==="ai"){
      const asOf=timeParam(query.get("asOf"),"asOf");
      if(asOf>nowIso)throw new TypeError("invalid_time_window");
      if(kind==="ai"){
        const source=query.get("source");
        if(source!==null&&!["x","tg"].includes(source))throw new TypeError("invalid_source");
        return {kind,asOf,source,tokenId:null,limit:Number(rawLimit)};
      }
      return {kind,asOf,limit:Number(rawLimit)};
    }
    const signal=query.get("signal");
    if(signal!==null&&!/^[a-z][a-z0-9_]{0,63}$/.test(signal))throw new TypeError("invalid_signal");
    return {kind,signal,limit:Number(rawLimit)};
  }
  const match=/^\/api\/intelligence\/v1\/tokens\/([^/]+)\/(timeline|links|swap-evidence|evidence|ai-context|summary|features|correlations|ai)$/.exec(url.pathname);
  if(!match)return null;
  let tokenId;
  try{tokenId=decodeURIComponent(match[1]);}
  catch{throw new TypeError("invalid_token_id");}
  if(!tokenId.startsWith("solana:")||parseTokenId(tokenId)?.id!==tokenId){
    throw new TypeError("invalid_token_id");
  }
  const kind=match[2];
  const query=url.searchParams;
  const legacy=new Set(["timeline","links","swap-evidence","evidence","ai-context"]);
  const routeAllowed=legacy.has(kind)
    ? new Set(["occurredBefore","knownAt","limit"])
    : ["correlations","ai"].includes(kind) ? new Set(["asOf","limit"]) : new Set(["asOf"]);
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
function boundedNumber(value,min,max){
  if(typeof value!=="number"||!Number.isFinite(value)||value<min||value>max)
    throw new TypeError("invalid_stored_ai_result");
  return value;
}
function safeModelId(value){
  if(typeof value!=="string"||!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value))
    throw new TypeError("invalid_stored_ai_model");
  return value;
}
function normalizeAiAnalysis(row){
  if(!["x","tg"].includes(row.source_system))throw new TypeError("invalid_stored_ai_source");
  const evidenceId=safeEvidenceId(row.evidence_ref);
  if(!evidenceId.startsWith(row.source_system=== "x"?"x:tweet:":"tg:message:"))
    throw new TypeError("invalid_stored_ai_evidence");
  const input=safeObject(row.result);
  const confidence=boundedNumber(input.confidence,0,1);
  let result;
  if(row.task==="sentiment"){
    if(!["bullish","bearish","neutral","mixed"].includes(input.label))
      throw new TypeError("invalid_stored_ai_result");
    if((input.directionAmbiguous!==undefined&&typeof input.directionAmbiguous!=="boolean")||
        (input.directionAmbiguous===true&&(input.label!=="mixed"||input.score!==0)))
        throw new TypeError("invalid_stored_ai_result");
      result={label:input.label,score:boundedNumber(input.score,-1,1),confidence,
        ...(input.directionAmbiguous===undefined?{}:{directionAmbiguous:input.directionAmbiguous})};
  }else if(row.task==="narrative"){
    if(input.narrativeId!==null&&(typeof input.narrativeId!=="string"||
        !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.narrativeId)))
      throw new TypeError("invalid_stored_ai_result");
    if(!Array.isArray(input.keywords)||input.keywords.length>10||
        input.keywords.some(value=>typeof value!=="string"||value.length>80||/[\u0000-\u001f]/.test(value)))
      throw new TypeError("invalid_stored_ai_result");
    result={narrativeId:input.narrativeId,confidence,keywords:input.keywords};
  }else throw new TypeError("invalid_stored_ai_task");
  if(typeof row.model_version!=="string"||!row.model_version.length||row.model_version.length>128||
      /[\u0000-\u001f]/.test(row.model_version))throw new TypeError("invalid_stored_ai_model");
  const contextEvidence=input.contextEvidence??[];
  if(!Array.isArray(contextEvidence)||contextEvidence.length>2)throw new TypeError("invalid_stored_ai_context");
  const context=contextEvidence.map(item=>{
    if(!item||typeof item.textSha256!=="string"||!/^[a-f0-9]{64}$/.test(item.textSha256)||
      typeof item.evidenceRef!=="string"||!item.evidenceRef.startsWith(evidenceId.split(":").slice(0,3).join(":")+":"))
      throw new TypeError("invalid_stored_ai_context");
    const observedAt=safeTime(item.observedAt),postedAt=safeTime(item.postedAt);
    if(observedAt>safeTime(row.analyzed_at))throw new TypeError("invalid_stored_ai_context");
    return {evidenceRef:safeEvidenceId(item.evidenceRef),textSha256:item.textSha256,postedAt,observedAt};
  });
  return {
    source:row.source_system,evidenceId,task:row.task,result,
    ...(input.contextEvidence===undefined?{}:{contextEvidence:context}),
    evidenceRefs:safeRefs(input.evidenceRefs).filter(ref=>ref===evidenceId||context.some(item=>item.evidenceRef===ref)),
    modelId:safeModelId(row.model_id),modelVersion:row.model_version,
    sourceObservedAt:safeTime(row.source_observed_at),analyzedAt:safeTime(row.analyzed_at),
    interpretation:"model_classification_of_source_content",
  };
}
function normalizeGroundedExplanation(row){
  const grounding=safeObject(row.explanation_grounding);
  if(grounding.version!=="alert-facts-v1")return null;
  if(typeof row.explanation!=="string"||!row.explanation.length||row.explanation.length>4000)
    throw new TypeError("invalid_stored_explanation");
  const allowed=safeRefs(row.evidence_refs);
  return {
    text:row.explanation,modelId:safeModelId(row.explanation_model_id),
    createdAt:safeTime(row.explanation_created_at),
    evidenceRefs:safeRefs(row.explanation_evidence_refs).filter(ref=>allowed.includes(ref)),
    grounding:{version:"alert-facts-v1"},
  };
}
function normalizeSummary(row,request){
  return {
    schemaVersion:"token-intelligence-v1",tokenId:request.tokenId,
    day:row.day===null||row.day===undefined?null:(row.day instanceof Date?row.day.toISOString().slice(0,10):String(row.day).slice(0,10)),
    asOf:safeTime(row.as_of),
    maxInputObservedAt:safeTime(row.max_input_observed_at),
    historicalCompleteness:"unknown",dataAvailable:true,
    metrics:{
      tgMentions:numberOrNull(row.tg_mentions),tgUniqueAuthors:numberOrNull(row.tg_unique_authors),
      tgCopypastaRatio:numberOrNull(row.tg_copypasta_ratio),tgSentimentScore:numberOrNull(row.tg_sentiment_score),
      tgScamRatio:numberOrNull(row.tg_scam_ratio),xMentions:numberOrNull(row.x_mentions),
      xUniqueAuthors:numberOrNull(row.x_unique_authors),xBotRatio:numberOrNull(row.x_bot_ratio),
      xSentimentScore:numberOrNull(row.x_sentiment_score),chainTrades:numberOrNull(row.chain_trades),
      chainTransactions:numberOrNull(row.chain_transactions),chainSwapEvidenceCount:numberOrNull(row.chain_swap_evidence_count),
      chainUniqueWallets:numberOrNull(row.chain_unique_wallets),chainVolumeUsd:numberOrNull(row.chain_volume_usd),
      chainLiquidityUsd:numberOrNull(row.chain_liquidity_usd),chainSmartMoneyBought:numberOrNull(row.chain_smart_money_bought),
      chainRugRisk:numberOrNull(row.chain_rug_risk),
    },
    firstMentionTgAt:row.first_mention_tg_at===null?null:safeTime(row.first_mention_tg_at),
    firstMentionXAt:row.first_mention_x_at===null?null:safeTime(row.first_mention_x_at),
    firstTradeAt:row.first_trade_at===null?null:safeTime(row.first_trade_at),
    firstSwapEvidenceAt:row.first_swap_evidence_at===null?null:safeTime(row.first_swap_evidence_at),
    scores:{
      attention:numberOrNull(row.attention_score),credibility:numberOrNull(row.credibility_score),
      risk:numberOrNull(row.risk_score),momentum:numberOrNull(row.momentum_score),
      version:typeof row.score_version==="string"?row.score_version:null,
      reason:safeObject(row.score_reason),
      interpretation:{attention:"heuristic",credibility:"heuristic",risk:"heuristic",momentum:"heuristic"},
      calibration:"not_probability",
    },
    dataConfidence:numberOrNull(row.data_confidence),
    sourceCoverage:safeCoverage(row.source_coverage),
  };
}
export async function queryTokenApi(pool,request){
  if(request.kind==="ai-catalog")return aiDataCatalog();
  if(request.kind==="ai-context")return queryAiTokenContext(pool,request);
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
  if(request.kind==="evidence"){
    // Two independent evidence contracts, one validated canonical ID and
    // identical as-of boundaries. Do not misrepresent raw Blockchain swap
    // observations as verified social mentions, finalized trades or PnL.
    // Independent bounded pages and truncation keep provenance intact.
    const [linkRows,swapRows]=await Promise.all([
      queryActiveTokenLinks(pool,request.tokenId,
        request.occurredBefore,request.knownAt,request.limit+1),
      queryActiveBlockchainSwapEvidence(pool,request.tokenId,
        request.occurredBefore,request.knownAt,request.limit+1),
    ]);
    return {
      ...responseBase(request,[],linkRows.length>request.limit||swapRows.length>request.limit),
      socialLinks:linkRows.slice(0,request.limit).map(row=>normalizeLink(row,request.tokenId)),
      blockchainSwapEvidence:swapRows.slice(0,request.limit)
        .map(row=>normalizeSwapEvidence(row,request.tokenId)),
      sourceScope:"separate_social_and_chain_evidence",
      independentLimitPerSourceType:request.limit,
      socialLinksTruncated:linkRows.length>request.limit,
      blockchainSwapEvidenceTruncated:swapRows.length>request.limit,
      editDeleteCoverage:"not_guaranteed_for_legacy_source_history",
      blockchainFinality:"not_independently_verified",
      tradeStatus:"not_a_confirmed_trade_tape",
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
        AND created_at <= $2
      ORDER BY day DESC,as_of DESC LIMIT 1`,[request.tokenId,request.asOf]);
    if(!result.rows.length)return {
      schemaVersion:"token-intelligence-v1",tokenId:request.tokenId,asOf:request.asOf,
      dataAvailable:false,historicalCompleteness:"unknown",sourceCoverage:{tg:"unknown",x:"unknown",blockchain:"unknown"},
    };
    return normalizeSummary(result.rows[0],request);
  }
  if(request.kind==="features"){
    const result=await pool.query(`SELECT canonical_token_id,as_of,max_input_observed_at,computed_at,feature_version,features
      FROM chain_token_features WHERE canonical_token_id=$1 AND as_of <= $2 AND max_input_observed_at <= $2
        AND computed_at <= $2
      ORDER BY as_of DESC,CASE feature_version WHEN 'features-v3' THEN 3 WHEN 'features-v2' THEN 2 ELSE 1 END DESC,computed_at DESC
      LIMIT 1`,[request.tokenId,request.asOf]);
    const row=result.rows[0];
    if(!row)return {schemaVersion:"token-intelligence-v1",tokenId:request.tokenId,asOf:request.asOf,dataAvailable:false};
    return {
      schemaVersion:"token-intelligence-v1",tokenId:request.tokenId,
      asOf:safeTime(row.as_of),maxInputObservedAt:safeTime(row.max_input_observed_at),
      computedAt:row.computed_at===null||row.computed_at===undefined?null:safeTime(row.computed_at),
      featureVersion:row.feature_version,features:safeFeatures(row.features),dataAvailable:true,
    };
  }
  if(request.kind==="ai"){
    const result=await pool.query(`SELECT analysis.source_system,analysis.evidence_ref,analysis.task,
      analysis.model_id,analysis.model_version,analysis.result,analysis.source_observed_at,analysis.analyzed_at
      FROM ai_message_analyses analysis
      JOIN timeline_events event ON event.source_system=analysis.source_system
        AND event.source_event_kind=analysis.source_event_kind AND event.event_key=analysis.event_key
        AND event.evidence_source_id=analysis.evidence_ref
      JOIN intelligence_inbox inbox ON inbox.source_system=event.source_system
        AND inbox.event_kind=event.source_event_kind AND inbox.event_key=event.event_key
      WHERE analysis.analyzed_at <= $2 AND analysis.source_observed_at <= $2
        AND event.observed_at <= $2 AND event.occurred_at <= $2 AND inbox.ingested_at <= $2
        AND NOT EXISTS (
          SELECT 1 FROM intelligence_inbox removed
          WHERE removed.source_system=analysis.source_system
            AND removed.evidence_source_id=analysis.evidence_ref
            AND removed.event_kind IN ('message_deleted','token_links_invalidated')
            AND removed.ingested_at <= $2
            AND (removed.event_kind='message_deleted' OR removed.ingested_at>=inbox.ingested_at)
        )
        AND ($4::text IS NULL OR analysis.source_system=$4)
          AND NOT EXISTS(SELECT 1 FROM ai_message_attempts excluded
            WHERE excluded.source_system=analysis.source_system AND excluded.source_event_kind=analysis.source_event_kind
              AND excluded.event_key=analysis.event_key AND excluded.error_code='excluded_template_v1'
              AND excluded.next_attempt_at<=$2)
        AND ($1::text IS NULL OR EXISTS (
          SELECT 1 FROM timeline_event_entities entity
          WHERE entity.source_system=event.source_system AND entity.source_event_kind=event.source_event_kind
            AND entity.event_key=event.event_key AND entity.kind='token' AND entity.canonical_id=$1
        ) OR EXISTS (
          SELECT 1 FROM token_link_observations verified
          WHERE verified.source_system=analysis.source_system AND verified.evidence_source_id=analysis.evidence_ref
            AND verified.state='verified' AND verified.canonical_token_id=$1
            AND verified.observed_at <= analysis.analyzed_at AND verified.inserted_at <= analysis.analyzed_at
            AND COALESCE(verified.occurred_at,verified.observed_at) <= $2
            AND NOT EXISTS (
              SELECT 1 FROM token_link_observations invalidated
              WHERE invalidated.source_system=verified.source_system
                AND invalidated.evidence_source_id=verified.evidence_source_id AND invalidated.state='invalidated'
                AND invalidated.observed_at >= LEAST(verified.observed_at,analysis.source_observed_at)
                AND invalidated.observed_at <= $2 AND invalidated.inserted_at <= $2
            )
        ))
      ORDER BY analysis.analyzed_at DESC,analysis.analysis_id DESC LIMIT $3`,
    [request.tokenId,request.asOf,request.limit+1,request.source??null]);
    return {
      schemaVersion:"token-intelligence-v1",tokenId:request.tokenId,asOf:request.asOf,
      historicalCompleteness:"unknown",truncated:result.rows.length>request.limit,
      items:result.rows.slice(0,request.limit).map(normalizeAiAnalysis),
    };
  }
  if(request.kind==="correlations"){
    const result=await pool.query(`SELECT event_kind,event_at,outcome_kind,outcome_at,lift,ci_low,ci_high,p_value,
      baseline,sample_size,evaluated_at,data_cutoff_at,model_id FROM (
        SELECT DISTINCT ON (canonical_token_id,event_kind,outcome_kind,evaluated_at,data_cutoff_at,model_id)
          canonical_token_id,event_kind,event_at,outcome_kind,outcome_at,lift,ci_low,ci_high,p_value,
          baseline,sample_size,evaluated_at,data_cutoff_at,model_id
        FROM token_correlations WHERE canonical_token_id=$1 AND evaluated_at <= $2 AND created_at <= $2
        ORDER BY canonical_token_id,event_kind,outcome_kind,evaluated_at,data_cutoff_at,model_id,event_at ASC
      ) grouped ORDER BY p_value ASC NULLS LAST,evaluated_at DESC LIMIT $3`,
    [request.tokenId,request.asOf,request.limit+1]);
    const items=result.rows.slice(0,request.limit).map((row)=>{
      const baseline=safeObject(row.baseline);
      return {eventKind:String(row.event_kind),eventAt:safeTime(row.event_at),outcomeKind:String(row.outcome_kind),
        outcomeAt:null,eventWindowEnd:typeof baseline.eventWindowEnd==="string"?safeTime(baseline.eventWindowEnd):null,
        outcomeWindowStart:typeof baseline.outcomeWindowStart==="string"?safeTime(baseline.outcomeWindowStart):null,
        outcomeWindowEnd:typeof baseline.outcomeWindowEnd==="string"?safeTime(baseline.outcomeWindowEnd):null,
        lift:numberOrNull(row.lift),ciLow:numberOrNull(row.ci_low),ciHigh:numberOrNull(row.ci_high),pValue:numberOrNull(row.p_value),
        baseline,sampleSize:numberOrNull(row.sample_size),evaluatedAt:safeTime(row.evaluated_at),
        dataCutoffAt:safeTime(row.data_cutoff_at),modelId:typeof row.model_id==="string"?row.model_id:null};
    });
    return {schemaVersion:"token-intelligence-v1",tokenId:request.tokenId,asOf:request.asOf,
      historicalCompleteness:"unknown",truncated:result.rows.length>request.limit,items};
  }
  if(request.kind==="signals"){
    const result=await pool.query(`SELECT alert.alert_id,alert.canonical_token_id,alert.alert_type,alert.severity,
      alert.triggered_at,alert.as_of,alert.score,alert.score_version,alert.evidence_refs,history.status,
      explanation.explanation,explanation.model_id AS explanation_model_id,
      explanation.created_at AS explanation_created_at,explanation.evidence_refs AS explanation_evidence_refs,
      explanation.grounding AS explanation_grounding
      FROM token_alerts alert JOIN LATERAL (
        SELECT status FROM token_alert_status_history WHERE alert_id=alert.alert_id AND changed_at <= $1
        ORDER BY changed_at DESC,history_id DESC LIMIT 1
      ) history ON TRUE
      LEFT JOIN LATERAL (
        SELECT explanation,model_id,created_at,evidence_refs,grounding FROM signal_explanations
        WHERE alert_id=alert.alert_id AND created_at <= $1 AND grounding->>'version'='alert-facts-v1'
        ORDER BY created_at DESC,explanation_id DESC LIMIT 1
      ) explanation ON TRUE
      WHERE alert.triggered_at <= $1 AND alert.created_at <= $1 AND history.status NOT IN ('resolved','sending')
      ORDER BY alert.triggered_at DESC LIMIT $2`,[request.asOf,request.limit+1]);
    const items=result.rows.slice(0,request.limit).map((row)=>({
      alertId:String(row.alert_id),tokenId:String(row.canonical_token_id),alertType:String(row.alert_type),
      severity:String(row.severity),triggeredAt:safeTime(row.triggered_at),asOf:safeTime(row.as_of),
      score:numberOrNull(row.score),scoreVersion:typeof row.score_version==="string"?row.score_version:null,
      evidenceRefs:safeRefs(row.evidence_refs),status:String(row.status),
      explanation:normalizeGroundedExplanation(row),
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
