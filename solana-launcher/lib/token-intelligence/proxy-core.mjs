/**
 * ARCH-11: server-side-only, defense-in-depth projection of the local
 * Intelligence v1 response. NEVER import this from a client component.
 * No arbitrary upstream URL, credentials in response, or source DB access.
 */
const SOURCES=new Set(["x","tg","blockchain"]);
const KINDS=new Set([
  "tweet_published","tg_message_published","chain_transaction",
  "trade_executed","signal_detected","signal_outcome",
]);
const UTC=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const B58=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_BODY=196_608;
const DEFAULT_TIMEOUT_MS=7000;

export class SafeProxyError extends Error{
  constructor(code,status){
    super(code);
    this.code=code;
    this.status=status;
  }
}
function asUtc(input,field){
  if(typeof input!=="string"||!UTC.test(input))
    throw new SafeProxyError("invalid_"+field,400);
  const date=new Date(input);
  if(!Number.isFinite(date.getTime()))
    throw new SafeProxyError("invalid_"+field,400);
  const expected=date.toISOString();
  const normalized=input.replace(/Z$/,input.includes(".")?
    (input.match(/\.(\d{1,3})Z$/)?.[1]??"").padEnd(3,"0")+"Z":
    ".000Z");
  if(normalized!==expected)throw new SafeProxyError("invalid_"+field,400);
  return expected;
}
export function parseClientTokenQuery(search,now=new Date()){
  if(typeof search!=="string"||search.length>512)throw new SafeProxyError("invalid_query",400);
  const query=new URLSearchParams(search);
  for(const key of query.keys()){
    if(!["knownAt","occurredBefore","limit"].includes(key)||query.getAll(key).length!==1){
      throw new SafeProxyError("invalid_query",400);
    }
  }
  const knownAt=asUtc(query.get("knownAt"),"known_at");
  const occurredBefore=asUtc(query.get("occurredBefore"),"occurred_before");
  if(knownAt>now.toISOString()||occurredBefore>knownAt){
    throw new SafeProxyError("invalid_time_window",400);
  }
  const rawLimit=query.get("limit")??"50";
  if(!/^[1-9][0-9]*$/.test(rawLimit)||Number(rawLimit)>100)
    throw new SafeProxyError("invalid_limit",400);
  return {knownAt,occurredBefore,limit:Number(rawLimit)};
}
export function assertMintShape(value){
  if(typeof value!=="string"||!B58.test(value))
    throw new SafeProxyError("invalid_mint",400);
  return value;
}
function safeDate(value){
  if(typeof value!=="string"||!UTC.test(value)||
     !Number.isFinite(Date.parse(value)))throw new SafeProxyError("upstream_invalid",502);
  return new Date(value).toISOString();
}
function source(value){
  if(typeof value!=="string"||!SOURCES.has(value))
    throw new SafeProxyError("upstream_invalid",502);
  return value;
}
function evidence(value){
  if(typeof value!=="string"||value.length>256||
    !/^(?:x:tweet:|tg:message:|chain:tx:)[A-Za-z0-9:_-]+$/.test(value))
    throw new SafeProxyError("upstream_invalid",502);
  return value;
}
function sanitizeItems(items,resource,limit){
  if(!Array.isArray(items)||items.length>limit)
    throw new SafeProxyError("upstream_invalid",502);
  return items.map(item=>{
    if(!item||typeof item!=="object"||Array.isArray(item))
      throw new SafeProxyError("upstream_invalid",502);
    const common={
      source:source(item.source),
      evidenceId:evidence(item.evidenceId),
      occurredAt:item.occurredAt===null&&resource==="links"?null:safeDate(item.occurredAt),
      observedAt:safeDate(item.observedAt),
    };
    if(resource==="timeline"){
      if(!KINDS.has(item.kind))throw new SafeProxyError("upstream_invalid",502);
      return {...common,kind:item.kind};
    }
    if(!["x","tg"].includes(common.source)||
       item.verification!=="source_verified_spl_mint_account")
      throw new SafeProxyError("upstream_invalid",502);
    return {...common,verification:"source_verified_spl_mint_account"};
  });
}
export function projectVerifiedResponse(json,resource,tokenId,query){
  if(!json||typeof json!=="object"||Array.isArray(json)||
     json.schemaVersion!=="token-intelligence-v1"||
     json.tokenId!==tokenId ||
     json.knownAt!==query.knownAt||
     json.occurredBefore!==query.occurredBefore||
     json.historicalCompleteness!=="unknown"||
     typeof json.truncated!=="boolean"){
    throw new SafeProxyError("upstream_invalid",502);
  }
  return {
    schemaVersion:"potapoff-token-intelligence-v1",
    tokenId,
    knownAt:query.knownAt,
    occurredBefore:query.occurredBefore,
    historicalCompleteness:"unknown",
    coverage:"observed_and_qualified_events_only",
    ...(resource==="links"?{
      linkState:"active_as_known_at",
      editDeleteCoverage:"not_guaranteed_for_legacy_source_history",
    }:{}),
    truncated:json.truncated,
    items:sanitizeItems(json.items,resource,query.limit),
  };
}
async function readBounded(response){
  const reader=response.body?.getReader();
  if(!reader)throw new SafeProxyError("upstream_unavailable",502);
  let size=0;
  const chunks=[];
  try{
    while(true){
      const part=await reader.read();
      if(part.done)break;
      size+=part.value.byteLength;
      if(size>MAX_BODY)throw new SafeProxyError("upstream_too_large",502);
      chunks.push(part.value);
    }
  }finally{await reader.cancel().catch(()=>{})}
  const bytes=new Uint8Array(size);
  let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  try{return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes))}
  catch{throw new SafeProxyError("upstream_invalid",502)}
}
export function validateProxyConfiguration(env){
  if(env.POTAPOFF_TOKEN_INTELLIGENCE_ENABLED!=="true")
    throw new SafeProxyError("feature_disabled",503);
  const token=env.INTELLIGENCE_API_TOKEN;
  if(typeof token!=="string"||!/^[A-Za-z0-9_-]{32,128}$/.test(token))
    throw new SafeProxyError("upstream_unavailable",503);
  const rawPort=env.INTELLIGENCE_API_PORT??"3182";
  if(!/^[1-9][0-9]*$/.test(rawPort)||Number(rawPort)>65535)
    throw new SafeProxyError("upstream_unavailable",503);
  return {token,port:Number(rawPort)};
}
/**
 * Caller MUST authenticate the POTAPoff user/session and apply per-user/IP
 * rate limits before invoking. The Bearer credential never returns to client.
 */
export async function fetchTokenIntelligence(mint,resource,query,{
  env=process.env,fetchImpl=fetch,timeoutMs=DEFAULT_TIMEOUT_MS,
}={}){
  assertMintShape(mint);
  if(resource!=="timeline"&&resource!=="links")
    throw new SafeProxyError("invalid_resource",404);
  const {token,port}=validateProxyConfiguration(env);
  const tokenId="solana:"+mint;
  const params=new URLSearchParams({
    knownAt:query.knownAt,occurredBefore:query.occurredBefore,
    limit:String(query.limit),
  });
  // Fixed loopback origin: never accept client-selected domains or arbitrary
  // INTELLIGENCE_API_URL, eliminating open proxy/SSRF.
  const url="http://127.0.0.1:"+port+"/api/intelligence/v1/tokens/"+
    encodeURIComponent(tokenId)+"/"+resource+"?"+params;
  try{
    const response=await fetchImpl(url,{
      method:"GET",headers:{
        Authorization:"Bearer "+token,
        Accept:"application/json",
      },redirect:"error",cache:"no-store",signal:AbortSignal.timeout(timeoutMs),
    });
    if(!response.ok){
      if(response.status===429)throw new SafeProxyError("upstream_rate_limited",503);
      throw new SafeProxyError("upstream_unavailable",503);
    }
    const value=await readBounded(response);
    return projectVerifiedResponse(value,resource,tokenId,query);
  }catch(error){
    if(error instanceof SafeProxyError)throw error;
    throw new SafeProxyError("upstream_unavailable",503);
  }
}
