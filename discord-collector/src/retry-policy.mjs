const NETWORK_CODES=new Set([
  "ECONNABORTED","ECONNREFUSED","ECONNRESET","EAI_AGAIN","EHOSTUNREACH",
  "ENETDOWN","ENETUNREACH","ENOTFOUND","EPIPE","ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT","UND_ERR_CONNECT_TIMEOUT","UND_ERR_HEADERS_TIMEOUT","UND_ERR_SOCKET",
]);
const TRANSIENT_PREFLIGHT_CODES=new Set(["discord_api_unavailable","discord_rate_limited"]);

export function isTransientDiscordRestError(error){
  let current=error;
  for(let depth=0;current&&depth<4;depth++){
    const status=Number(current.status??current.statusCode??current.httpStatus);
    if(status===429||(status>=500&&status<=599))return true;
    if(current.name==="AbortError"||current.name==="TimeoutError")return true;
    if(typeof current.code==="string"&&NETWORK_CODES.has(current.code.toUpperCase()))return true;
    current=current.cause??current.originalError??null;
  }
  return false;
}

export function isTransientPermissionPreflightReport(report){
  const codes=new Set();
  if(typeof report?.errorCode==="string")codes.add(report.errorCode);
  for(const group of report?.guilds??[]){
    if(typeof group?.errorCode==="string")codes.add(group.errorCode);
    for(const channel of group?.channels??[])
      if(typeof channel?.errorCode==="string")codes.add(channel.errorCode);
  }
  return codes.size>0&&[...codes].every(code=>TRANSIENT_PREFLIGHT_CODES.has(code));
}

export function retryDelayMs(attempt,{baseMs=1_000,maxMs=300_000}={}){
  if(!Number.isSafeInteger(attempt)||attempt<0)
    throw new RangeError("retry attempt must be a nonnegative safe integer");
  if(!Number.isSafeInteger(baseMs)||baseMs<1||
     !Number.isSafeInteger(maxMs)||maxMs<baseMs)
    throw new RangeError("retry delay bounds are invalid");
  return Math.min(maxMs,baseMs*2**Math.min(attempt,20));
}

export function permissionPreflightRetryBaseMs(report,error){
  if(Number(error?.status??error?.statusCode)===429)return 30_000;
  const codes=new Set();
  if(typeof report?.errorCode==="string")codes.add(report.errorCode);
  for(const group of report?.guilds??[]){
    if(typeof group?.errorCode==="string")codes.add(group.errorCode);
    for(const channel of group?.channels??[])
      if(typeof channel?.errorCode==="string")codes.add(channel.errorCode);
  }
  return codes.has("discord_rate_limited")?30_000:1_000;
}
