// A deliberately narrow, non-predictive, local-only evidence presentation.
// The API already validates DB evidence; this projection whitelists fields again
// so future internal columns and source content never appear in local reports.
const SOURCES=new Set(["x","tg"]);
const UTC=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function record(value,name){
  if(!value||typeof value!=="object"||Array.isArray(value))
    throw new TypeError("invalid_"+name);
  return value;
}
function timestamp(value,name){
  if(typeof value!=="string"||!UTC.test(value)||new Date(value).toISOString()!==value)
    throw new TypeError("invalid_"+name);
  return value;
}
function identity(value){
  if(typeof value!=="string"||value.length>256||
     !/^(?:x:tweet:|tg:message:|chain:tx:)[A-Za-z0-9:_-]+$/.test(value))
    throw new TypeError("invalid_evidence_identity");
  return value;
}
function within(item,request){
  const observed=timestamp(item.observedAt,"observed_at");
  const occurred=item.occurredAt===null?null:timestamp(item.occurredAt,"occurred_at");
  if(observed>request.knownAt||(occurred!==null&&occurred>request.occurredBefore))
    throw new TypeError("evidence_outside_as_of");
  return {occurredAt:occurred,observedAt:observed};
}
function social(item,request){
  record(item,"social_item");
  if(!SOURCES.has(item.source)||
     item.verification!=="source_verified_spl_mint_account")
    throw new TypeError("unverified_social_evidence");
  return {
    source:item.source,evidenceId:identity(item.evidenceId),
    ...within(item,request),
    verification:"source_verified_spl_mint_account",
  };
}
function swap(item,request){
  record(item,"chain_item");
  if(item.source!=="blockchain"||
     item.attribution!=="provider_parsed_wallet_swap"||
     item.finality!=="not_independently_verified"||
     item.tradeCompleteness!=="unknown")
    throw new TypeError("unsupported_chain_evidence");
  return {
    source:"blockchain",evidenceId:identity(item.evidenceId),
    ...within(item,request),
    attribution:"provider_parsed_wallet_swap",
    finality:"not_independently_verified",
    tradeCompleteness:"unknown",
  };
}
function timelineItem(item,request){
  record(item,"timeline_item");
  if(!["x","tg","blockchain"].includes(item.source)||
     typeof item.kind!=="string"||
     !["tweet_published","tg_message_published","chain_transaction",
       "trade_executed","signal_detected","signal_outcome"].includes(item.kind))
    throw new TypeError("invalid_timeline_evidence");
  return {
    source:item.source,kind:item.kind,evidenceId:identity(item.evidenceId),
    ...within(item,request),
  };
}
function assertEnvelope(input,request,name){
  record(input,name);
  if(input.schemaVersion!=="token-intelligence-v1"||
     input.tokenId!==request.tokenId||
     input.occurredBefore!==request.occurredBefore||
     input.knownAt!==request.knownAt||
     input.historicalCompleteness!=="unknown"||
     input.coverage!=="observed_and_qualified_events_only"||
     typeof input.truncated!=="boolean"){
    throw new TypeError("invalid_"+name+"_envelope");
  }
}
/** Local destination evidence report; bounded samples are never population totals. */
export function composeLocalTokenReport(request,evidence,timeline){
  record(request,"request");
  timestamp(request.knownAt,"known_at");
  timestamp(request.occurredBefore,"occurred_before");
  if(request.occurredBefore>request.knownAt||
     typeof request.tokenId!=="string"||!request.tokenId.startsWith("solana:")||
     !Number.isInteger(request.limit)||request.limit<1||request.limit>100){
    throw new TypeError("invalid_request");
  }
  assertEnvelope(evidence,request,"evidence");
  assertEnvelope(timeline,request,"timeline");
  if(evidence.sourceScope!=="separate_social_and_chain_evidence"||
     evidence.independentLimitPerSourceType!==request.limit||
     evidence.tradeStatus!=="not_a_confirmed_trade_tape"||
     evidence.blockchainFinality!=="not_independently_verified"||
     typeof evidence.socialLinksTruncated!=="boolean"||
     typeof evidence.blockchainSwapEvidenceTruncated!=="boolean"||
     !Array.isArray(evidence.socialLinks)||
     !Array.isArray(evidence.blockchainSwapEvidence)||
     !Array.isArray(timeline.items))throw new TypeError("invalid_evidence_projection");
  if(evidence.socialLinks.length>request.limit||
     evidence.blockchainSwapEvidence.length>request.limit||
     timeline.items.length>request.limit)throw new RangeError("unexpected_page_size");
  const socialLinks=evidence.socialLinks.map(x=>social(x,request));
  const blockchainSwapEvidence=evidence.blockchainSwapEvidence.map(x=>swap(x,request));
  const timelineEvents=timeline.items.map(x=>timelineItem(x,request));
  return {
    schemaVersion:"local-token-evidence-report-v1",
    mode:"local_intelligence_destination_only",
    tokenId:request.tokenId,
    occurredBefore:request.occurredBefore,
    knownAt:request.knownAt,
    historicalCompleteness:"unknown",
    sourceCoverage:"not_established",
    reportCountsAre:"bounded_sample_not_total_population",
    sampleCounts:{
      xVerifiedLinks:socialLinks.filter(x=>x.source==="x").length,
      tgVerifiedLinks:socialLinks.filter(x=>x.source==="tg").length,
      providerParsedBlockchainSwaps:blockchainSwapEvidence.length,
      genericTimelineEvents:timelineEvents.length,
    },
    truncated:{
      socialLinks:evidence.socialLinksTruncated,
      blockchainSwapEvidence:evidence.blockchainSwapEvidenceTruncated,
      timeline:timeline.truncated,
    },
    socialLinks,blockchainSwapEvidence,timelineEvents,
    interpretation:{
      missingIsNotZero:true,
      social:"source-verified SPL mint links; no claim of complete X/TG coverage",
      blockchain:"provider-parsed swaps; finality and settled trades not verified",
      ai:"not_run_no_external_model",
      pnl:"not_available",
      predictiveValidity:"not_established",
    },
  };
}
export function formatLocalTokenReport(report){
  record(report,"report");
  const out=[
    "TOKEN INTELLIGENCE — LOCAL, OBSERVED EVIDENCE ONLY",
    "Mint: "+report.tokenId,
    "Occurred before: "+report.occurredBefore,
    "Known at: "+report.knownAt,
    "Historical coverage: UNKNOWN — missing data is not zero",
    "Counts are bounded samples, not population totals.",
    "",
    "Verified social mint links: X "+report.sampleCounts.xVerifiedLinks+
      " | Telegram "+report.sampleCounts.tgVerifiedLinks,
  ];
  for(const x of report.socialLinks){
    out.push("  "+x.source+" "+x.evidenceId+
      " occurred="+(x.occurredAt??"unknown")+" observed="+x.observedAt);
  }
  out.push("Blockchain provider-parsed revisions: "+report.sampleCounts.providerParsedBlockchainSwaps);
  for(const x of report.blockchainSwapEvidence){
    out.push("  "+x.evidenceId+" occurred="+(x.occurredAt??"unknown")+
      " observed="+x.observedAt+" (finality NOT VERIFIED)");
  }
  out.push("Generic timeline events: "+report.sampleCounts.genericTimelineEvents);
  for(const x of report.timelineEvents){
    out.push("  "+x.source+" "+x.kind+" "+x.evidenceId+
      " occurred="+(x.occurredAt??"unknown")+" observed="+x.observedAt);
  }
  const truncated=Object.entries(report.truncated).filter(([,value])=>value).map(([key])=>key);
  if(truncated.length)out.push("TRUNCATED sample: "+truncated.join(", "));
  out.push("AI: NOT RUN | Trade/PnL: UNKNOWN | Prediction: NOT VALIDATED");
  return out.join("\n")+"\n";
}
