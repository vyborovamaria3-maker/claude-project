import http from "node:http";
import {createHash,timingSafeEqual} from "node:crypto";
import {parseApiRequest,queryTokenApi} from "./routes.mjs";

export const API_HOST="127.0.0.1";
const MAX_REQUESTS_PER_MINUTE=60;
const MAX_IN_FLIGHT=8;
const JSON_HEADERS={
  "Content-Type":"application/json; charset=utf-8",
  "Cache-Control":"no-store, private",
  "Content-Security-Policy":"default-src 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options":"nosniff",
  "X-Frame-Options":"DENY",
  "Referrer-Policy":"no-referrer",
  "Cross-Origin-Resource-Policy":"same-origin",
};
export function validateApiToken(value){
  if(typeof value!=="string"||!/^[A-Za-z0-9_-]{32,128}$/.test(value)){
    throw new TypeError("api_token_configuration_invalid");
  }
  return value;
}
function sha(value){return createHash("sha256").update(value).digest()}
function checkAuthorization(request,expected){
  const all=request.rawHeaders.filter((value,index)=>index%2===0 &&
    value.toLowerCase()==="authorization");
  if(all.length!==1)return false;
  const supplied=request.headers.authorization;
  if(typeof supplied!=="string"||!supplied.startsWith("Bearer ")||
     supplied.length>160)return false;
  const candidate=supplied.slice("Bearer ".length);
  if(!/^[A-Za-z0-9_-]{32,128}$/.test(candidate))return false;
  return timingSafeEqual(sha(candidate),expected);
}
function response(res,status,body,headers={}){
  if(res.headersSent)return;
  const text=body===null?"":JSON.stringify(body);
  res.writeHead(status,{
    ...JSON_HEADERS,
    "Content-Length":Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}
/** No cookie sessions, permissive CORS, browser-side secrets or source DB
 * queries. Caller injects an Intelligence-only read-only PostgreSQL pool. */
export function createIntelligenceApi({
  token,pool,aiEnabled=false,aiToken,now=()=>new Date(),
  requestsPerMinute=MAX_REQUESTS_PER_MINUTE,maxInFlight=MAX_IN_FLIGHT,analyzeToken,crossPlatformEnabled=false,
}){
  const verifier=sha(validateApiToken(token));
  if(typeof aiEnabled!=="boolean")throw new TypeError("invalid_ai_opt_in");
  // External LLM gateway must never inherit the ordinary service token.
  // Explicit second credential is required before either AI route exists.
  const aiVerifier=aiEnabled?sha(validateApiToken(aiToken)):null;
  if(aiEnabled&&aiToken===token)throw new TypeError("ai_token_must_be_distinct");
  if(!pool||typeof pool.query!=="function")throw new TypeError("database_pool_required");
  if(!Number.isSafeInteger(requestsPerMinute)||requestsPerMinute<1||
     requestsPerMinute>1000||!Number.isSafeInteger(maxInFlight)||
     maxInFlight<1||maxInFlight>64)throw new TypeError("invalid_api_limits");
  let windowStart=Date.now(),consumed=0,inFlight=0;
  const server=http.createServer(async(req,res)=>{
    // This bound protects against large URLs before any DB/auth work.
    if(!req.url||req.url.length>2048){
      response(res,414,{error:"request_target_too_long"});return;
    }
    const time=Date.now();
    if(time-windowStart>=60_000){windowStart=time;consumed=0}
    consumed++;
    if(consumed>requestsPerMinute){
      response(res,429,{error:"rate_limited"},{"Retry-After":"60"});return;
    }
    if(inFlight>=maxInFlight){
      response(res,503,{error:"request_capacity_exhausted"});return;
    }
    inFlight++;
    try{
      const ordinaryAuthorized=checkAuthorization(req,verifier);
      const aiAuthorized=aiVerifier!==null&&checkAuthorization(req,aiVerifier);
      if(!ordinaryAuthorized&&!aiAuthorized){
        response(res,401,{error:"unauthorized"},
          {"WWW-Authenticate":"Bearer realm=\"intelligence\""});
        return;
      }
      // Paid work is possible only through an explicit authenticated POST.
      const tokenRequest=/^\/api\/intelligence\/v1\/tokens\/([^/]+)\/analyze$/.exec(req.url);
      if(req.method==='POST'&&tokenRequest){
        if(!ordinaryAuthorized){response(res,404,{error:'not_found'});return;}
        if(!analyzeToken){response(res,503,{error:'token_analysis_disabled'});return;}
        if(req.headers['transfer-encoding']!==undefined||
          (req.headers['content-length']!==undefined&&req.headers['content-length']!=='0')){
          response(res,400,{error:'request_body_forbidden'});return;
        }
        let tokenId;
        try{tokenId=decodeURIComponent(tokenRequest[1]);parseApiRequest('/api/intelligence/v1/tokens/'+encodeURIComponent(tokenId)+'/ai?asOf='+now().toISOString(),now());}
        catch{response(res,400,{error:'invalid_token_id'});return;}
        try{response(res,200,await analyzeToken(tokenId));}
        catch{response(res,503,{error:'token_analysis_unavailable'});}
        return;
      }
      if(req.method!=="GET"){
        response(res,405,{error:"method_not_allowed"},{"Allow":"GET"});return;
      }
      if(req.headers["transfer-encoding"]!==undefined||
         (req.headers["content-length"]!==undefined &&
          req.headers["content-length"]!=="0")){
        response(res,400,{error:"request_body_forbidden"});return;
      }
      let route;
      try{route=parseApiRequest(req.url,now())}
      catch{response(res,400,{error:"invalid_request"});return}
      if(route===null){
        response(res,404,{error:"not_found"});return;
      }
      if(!crossPlatformEnabled&&["summary","features","correlations","signals","backtest","ai"].includes(route.kind)){
        response(res,404,{error:"not_found"});return;
      }
      const isAiRoute=route.kind==="ai-catalog"||route.kind==="ai-context";
      if((isAiRoute&&!aiAuthorized)||(!isAiRoute&&!ordinaryAuthorized)){
        // Scope isolation: ordinary API token cannot access AI context,
        // and an AI gateway key cannot access existing raw-ish link IDs.
        response(res,404,{error:"not_found"});return;
      }
      try{
        const body=await queryTokenApi(pool,route);
        response(res,200,body);
      }catch{
        // PG provider exceptions can contain DSNs, raw source data and SQL.
        response(res,503,{error:"intelligence_database_unavailable"});
      }
    }finally{inFlight--;}
  });
  server.requestTimeout=10_000;
  server.headersTimeout=8_000;
  server.keepAliveTimeout=3_000;
  server.maxHeadersCount=32;
  server.maxRequestsPerSocket=100;
  return server;
}
export async function checkApiReadiness(pool){
  // Migration 004 is mandatory for the links endpoint. Fail CLOSED.
  const result=await pool.query(
    "SELECT to_regclass('intelligence_inbox') IS NOT NULL AS inbox,"+
    "to_regclass('timeline_events') IS NOT NULL AS timeline,"+
    "to_regclass('timeline_event_entities') IS NOT NULL AS entities,"+
    "to_regclass('token_link_observations') IS NOT NULL AS links,"+
    "to_regclass('blockchain_swap_evidence_revisions') IS NOT NULL AS swap_revisions",
  );
  if(!result.rows[0]?.inbox||!result.rows[0]?.timeline||
     !result.rows[0]?.entities||!result.rows[0]?.links){
    throw new Error("intelligence_api_migrations_001_002_004_required");
  }
  if(!result.rows[0]?.swap_revisions){
    throw new Error("intelligence_api_migration_005_required");
  }
}

/** Feature migrations 003 are mandatory ONLY when the AI read model is
 * explicitly enabled. Legacy v1 API stays compatible while AI is off. */
export async function checkAiReadiness(pool){
  const result=await pool.query(
    "SELECT to_regclass('feature_versions') IS NOT NULL AS feature_versions,"+
    "to_regclass('chain_token_features') IS NOT NULL AS feature_store",
  );
  if(!result.rows[0]?.feature_versions||!result.rows[0]?.feature_store)
    throw new Error("intelligence_ai_api_migration_003_required");
}

export async function checkCrossPlatformReadiness(pool){
  const names=["chain_token_features","model_registry","token_daily_cross_platform",
    "token_correlations","token_alerts","backtest_runs","token_alert_status_history","ai_message_analyses"];
  for(const name of names){
    const result=await pool.query("SELECT to_regclass($1) IS NOT NULL AS ready",[name]);
    if(!result.rows[0]?.ready)throw new Error("cross_platform_migrations_required");
  }
  const result=await pool.query("SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('signal_explanations') AND attname='grounding' AND NOT attisdropped) AS ready");
  if(!result.rows[0]?.ready)throw new Error("cross_platform_migration_009_required");
}
