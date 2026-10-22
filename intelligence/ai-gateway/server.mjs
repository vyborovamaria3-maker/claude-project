import http from "node:http";
import {createHash,timingSafeEqual} from "node:crypto";
import {validateApiToken} from "../api/server.mjs";
import {parseApiRequest} from "../api/routes.mjs";
import {analyzeWithOpenAi,validateModelConfig} from "./provider.mjs";

const AUTH_REALM='Bearer realm="ai-gateway"';
const PREFIX="/api/ai/v1/analyze-token";
const MAX_BODY=2048;
const MAX_CONTEXT=32768;
const HEADERS={
  "Content-Type":"application/json; charset=utf-8",
  "Cache-Control":"no-store, private",
  "Content-Security-Policy":"default-src 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options":"nosniff",
  "Referrer-Policy":"no-referrer",
  "Cross-Origin-Resource-Policy":"same-origin",
};
function digest(value){return createHash("sha256").update(value).digest()}
function authed(req,expected){
  const headerNames=req.rawHeaders.filter((_,i)=>i%2===0&&
    req.rawHeaders[i].toLowerCase()==="authorization");
  const auth=req.headers.authorization;
  if(headerNames.length!==1||typeof auth!=="string"||
     !auth.startsWith("Bearer ")||auth.length>160)return false;
  const candidate=auth.slice("Bearer ".length);
  if(!/^[A-Za-z0-9_-]{32,128}$/.test(candidate))return false;
  return timingSafeEqual(digest(candidate),expected);
}
function send(res,status,data,headers={}){
  if(res.headersSent)return;
  const text=JSON.stringify(data);
  res.writeHead(status,{...HEADERS,"Content-Length":Buffer.byteLength(text),...headers});
  res.end(text);
}
function safeInteger(value){
  return Number.isSafeInteger(value)&&value>=0&&value<=1_000_000;
}
function checkCounts(raw,keys){
  if(!raw||typeof raw!=="object"||Array.isArray(raw)||
     Object.keys(raw).some(k=>!keys.includes(k)))throw new Error("invalid_context_counts");
  const v={};
  for(const key of keys){
    if(!safeInteger(raw[key]))throw new Error("invalid_context_counts");
    v[key]=raw[key];
  }
  return v;
}
function sampleFields(source){
  if(!source||typeof source!=="object"||Array.isArray(source)||
     !safeInteger(source.sampleLimit)||source.sampleLimit<1||source.sampleLimit>50||
     typeof source.truncated!=="boolean")throw new Error("invalid_ai_samples");
  return {sampleLimit:source.sampleLimit,truncated:source.truncated};
}
const NUMERIC_FEATURES=new Set([
  "mentions_5m","mentions_15m","mentions_1h","unique_authors",
  "unique_sources","velocity","acceleration","sentiment_bullish_ratio",
  "bot_ratio","smart_money_bought_at","liquidity_usd","volume_24h_usd",
  "holder_concentration","data_confidence",
]);
function projectFeatures(snapshot){
  if(!snapshot||!["observed_snapshot","missing"].includes(snapshot.status))
    throw new Error("invalid_ai_features");
  if(snapshot.status==="missing"){
    if(snapshot.values!==null)return Promise.reject(new Error("invalid_missing_features"));
    return {status:"missing",values:null};
  }
  if(snapshot.featureVersion!=="features-v1"||
     !snapshot.values||typeof snapshot.values!=="object"||
     Array.isArray(snapshot.values))throw new Error("invalid_ai_features");
  const values={};
  for(const [key,value] of Object.entries(snapshot.values)){
    if(!NUMERIC_FEATURES.has(key))throw new Error("untrusted_feature_field");
    if(value!==null&&typeof value!=="number"&&
       !(key==="smart_money_bought_at"&&typeof value==="string"))
      throw new Error("invalid_feature_value");
    if(typeof value==="number"&&!Number.isFinite(value))throw new Error("invalid_feature_number");
    values[key]=value;
  }
  return {
    status:"observed_snapshot",featureVersion:"features-v1",
    asOf:snapshot.asOf,maxInputObservedAt:snapshot.maxInputObservedAt,
    computedAt:snapshot.computedAt,values,
  };
}
/** Explicit egress allowlist: never forward unknown future fields or raw IDs. */
export function projectModelContext(context,request){
  if(!context||context.schemaVersion!=="ai-token-context-v1"||
     context.outputSafety!=="aggregates_and_typed_features_only_no_raw_source_content"||
     context.tokenId!==request.tokenId||
     context.asOf?.occurredBefore!==request.occurredBefore||
     context.asOf?.knownAt!==request.knownAt||
     context.historicalCompleteness!=="unknown"||
     context.sampling!=="bounded_per_category_not_population_totals"||
     context.sourceCollectorLiveness!=="not_checked")
    throw new Error("invalid_ai_context");
  const e=context.evidence;
  if(!e||!e.verifiedSocialLinks||!e.blockchainSwapRevisions||
     !e.legacyTimeline)throw new Error("missing_ai_evidence");
  const social=sampleFields(e.verifiedSocialLinks);
  const chain=sampleFields(e.blockchainSwapRevisions);
  const legacy=sampleFields(e.legacyTimeline);
  const socialCounts=checkCounts(e.verifiedSocialLinks.observedSampleCounts,["x","tg"]);
  const legacyCounts=checkCounts(e.legacyTimeline.observedSampleCounts,
    ["x","tg","blockchain","twitter_research"]);
  if(!safeInteger(e.blockchainSwapRevisions.observedSampleCount)||
     Object.values(socialCounts).some(n=>n>social.sampleLimit)||
     Object.values(legacyCounts).some(n=>n>legacy.sampleLimit)||
     e.blockchainSwapRevisions.observedSampleCount>chain.sampleLimit||
     Object.values(socialCounts).reduce((a,b)=>a+b,0)>social.sampleLimit||
     Object.values(legacyCounts).reduce((a,b)=>a+b,0)>legacy.sampleLimit)
    throw new Error("invalid_ai_counts");
  const feature=projectFeatures(context.featureSnapshot);
  const modelContext={
    schemaVersion:"ai-token-context-v1",tokenId:request.tokenId,
    asOf:{occurredBefore:request.occurredBefore,knownAt:request.knownAt},
    historicalCompleteness:"unknown",sourceCollectorLiveness:"not_checked",
    sampling:"bounded_per_category_not_population_totals",
    evidence:{
      verifiedSocialLinks:{...social,observedSampleCounts:socialCounts,
        qualification:"source_verified_literal_spl_mint_only"},
      blockchainSwapRevisions:{...chain,
        observedSampleCount:e.blockchainSwapRevisions.observedSampleCount,
        finality:"not_independently_verified",tradeOrPnl:"not_established"},
      legacyTimeline:{...legacy,observedSampleCounts:legacyCounts,
        qualification:"not_a_verified_token_link"},
    },
    featureSnapshot:feature,
    outputSafety:"aggregates_and_typed_features_only_no_raw_source_content",
    missingDataPolicy:"missing_does_not_mean_zero",
  };
  if(JSON.stringify(modelContext).length>MAX_CONTEXT)throw new Error("oversize_ai_context");
  return modelContext;
}
async function boundedJson(response,max=MAX_CONTEXT){
  const length=response.headers?.get?.("content-length");
  if(length!==null&&length!==undefined&&Number(length)>max)
    throw new Error("oversize_intelligence_response");
  if(!response.body?.getReader)throw new Error("missing_response_stream");
  const reader=response.body.getReader();let count=0;const chunks=[];
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      count+=value.byteLength;
      if(count>max)throw new Error("oversize_intelligence_response");
      chunks.push(value);
    }
  }finally{try{await reader.cancel()}catch{}}
  const buffer=new Uint8Array(count);let offset=0;
  for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.byteLength}
  return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(buffer));
}
function parseBody(body,now){
  if(!body||typeof body!=="object"||Array.isArray(body)||
     Object.keys(body).some(k=>!["tokenId","occurredBefore","knownAt","limit"].includes(k))||
     typeof body.tokenId!=="string"||
     typeof body.occurredBefore!=="string"||
     typeof body.knownAt!=="string"||
     (body.limit!==undefined&&(!Number.isInteger(body.limit)||body.limit<1||body.limit>50)))
    throw new TypeError("invalid_analysis_request");
  const tokenId=encodeURIComponent(body.tokenId);
  const path="/api/intelligence/v1/tokens/"+tokenId+"/ai-context"+
    "?occurredBefore="+encodeURIComponent(body.occurredBefore)+
    "&knownAt="+encodeURIComponent(body.knownAt)+
    "&limit="+String(body.limit??25);
  const parsed=parseApiRequest(path,now);
  if(parsed?.kind!=="ai-context")throw new TypeError("invalid_analysis_request");
  return parsed;
}
async function parseLimitedBody(req){
  let length=0;const chunks=[];
  for await(const chunk of req){
    length+=chunk.length;
    if(length>MAX_BODY)throw new TypeError("request_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function createLoopbackOrigin(port){
  if(!Number.isSafeInteger(port)||port<1||port>65535)
    throw new TypeError("invalid_intelligence_api_port");
  return "http://127.0.0.1:"+port;
}
export function createAiGateway({
  clientToken,intelligenceToken,intelligencePort=3182,
  providerApiKey,providerModel,now=()=>new Date(),
  requestLimit=30,maxInFlight=2,fetchImpl=fetch,
  analyzeFn=analyzeWithOpenAi,
}){
  const auth=validateApiToken(clientToken);
  validateApiToken(intelligenceToken);
  if(auth===intelligenceToken)throw new TypeError("gateway_and_intelligence_tokens_must_differ");
  validateModelConfig({apiKey:providerApiKey,model:providerModel});
  const base=createLoopbackOrigin(intelligencePort);
  if(!Number.isInteger(requestLimit)||requestLimit<1||requestLimit>120||
     !Number.isInteger(maxInFlight)||maxInFlight<1||maxInFlight>8)
    throw new RangeError("invalid_gateway_limits");
  const verifier=digest(auth);
  let windowStart=Date.now(),calls=0,inFlight=0;
  const server=http.createServer(async(req,res)=>{
    if(!req.url||req.url.length>256){send(res,414,{error:"invalid_target"});return}
    const t=Date.now();
    if(t-windowStart>=60000){windowStart=t;calls=0}
    if(++calls>requestLimit){send(res,429,{error:"rate_limited"},{"Retry-After":"60"});return}
    if(inFlight>=maxInFlight){send(res,503,{error:"busy"});return}
    inFlight++;
    try{
      if(!authed(req,verifier)){
        send(res,401,{error:"unauthorized"},{"WWW-Authenticate":AUTH_REALM});return;
      }
      if(req.url!==PREFIX){send(res,404,{error:"not_found"});return}
      if(req.method!=="POST"){send(res,405,{error:"method_not_allowed"},{"Allow":"POST"});return}
      if(req.headers["transfer-encoding"]!==undefined||
         !/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers["content-type"]??"")){
        send(res,400,{error:"invalid_content_type"});return;
      }
      if(Number(req.headers["content-length"]??0)>MAX_BODY){
        send(res,413,{error:"request_too_large"});return;
      }
      let request;
      try{request=parseBody(await parseLimitedBody(req),now())}
      catch{send(res,400,{error:"invalid_analysis_request"});return}
      try{
        const controller=new AbortController();
        const timeout=setTimeout(()=>controller.abort(),5000);
        let context;
        try{
          const relative="/api/intelligence/v1/tokens/"+encodeURIComponent(request.tokenId)+
            "/ai-context?occurredBefore="+encodeURIComponent(request.occurredBefore)+
            "&knownAt="+encodeURIComponent(request.knownAt)+"&limit="+request.limit;
          const upstream=await fetchImpl(base+relative,{
            method:"GET",redirect:"error",signal:controller.signal,
            headers:{Authorization:"Bearer "+intelligenceToken},
          });
          if(!upstream.ok)throw new Error("intelligence_unavailable");
          context=projectModelContext(await boundedJson(upstream),request);
        }finally{clearTimeout(timeout)}
        const modelResponse=await analyzeFn({
          apiKey:providerApiKey,model:providerModel,context,
        });
        if(!modelResponse||typeof modelResponse.analysis!=="string"||
           modelResponse.analysis.length<1||modelResponse.analysis.length>6000||
           modelResponse.isTradingSignal!==false||
           modelResponse.modelOutputIsEvidence!==false)
          throw new Error("invalid_model_result");
        send(res,200,{
          schemaVersion:"ai-analysis-v1",tokenId:request.tokenId,
          asOf:context.asOf,analysis:modelResponse.analysis,
          model:modelResponse.model,classification:"unverified_model_interpretation",
          evidenceCompleteness:"unknown",isTradingSignal:false,
          providerFinalityVerified:false,
        });
      }catch{
        // No upstream errors, provider credentials, SQL, prompt or raw body.
        send(res,503,{error:"analysis_service_unavailable"});
      }
    }finally{inFlight--}
  });
  server.requestTimeout=10_000;
  server.headersTimeout=8000;
  server.keepAliveTimeout=3000;
  server.maxHeadersCount=32;
  server.maxRequestsPerSocket=50;
  return server;
}
