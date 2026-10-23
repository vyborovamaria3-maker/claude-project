import http from "node:http";
import {randomUUID,createHash,timingSafeEqual} from "node:crypto";
import {parseApiRequest} from "./routes.mjs";

const BASE="http://127.0.0.1:";
const HEADERS={"Content-Type":"application/json; charset=utf-8",
  "Cache-Control":"no-store, private","X-Content-Type-Options":"nosniff",
  "Content-Security-Policy":"default-src 'none'; frame-ancestors 'none'"};
function digest(value){return createHash("sha256").update(value).digest();}
async function boundedJsonResponse(response,maxBytes=1024*1024){
  const header=response.headers.get("content-length");
  if(header!==null && /^\d+$/.test(header) && Number(header)>maxBytes)
    throw new Error("upstream_response_too_large");
  if(!response.body)throw new Error("upstream_response_missing");
  const reader=response.body.getReader();
  const chunks=[];let count=0;
  try{
    for(;;){
      const {done,value}=await reader.read();
      if(done)break;
      count+=value.byteLength;
      if(count>maxBytes)throw new Error("upstream_response_too_large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks.map(item=>Buffer.from(item))).toString("utf8"));
  }finally{
    try{await reader.cancel()}catch{}
    reader.releaseLock();
  }
}
function reply(res,status,body){
  const content=JSON.stringify(body);
  res.writeHead(status,{...HEADERS,"Content-Length":Buffer.byteLength(content)});
  res.end(content);
}
export function createPotapoffGateway({clients,internalApiToken,internalApiPort=3182,auditDb,
  fetchImpl=fetch,now=()=>new Date()}){
  if(!Array.isArray(clients)||!clients.length||clients.length>8||
     clients.some(c=>!c||!["viewer","analyst"].includes(c.role)||
       typeof c.id!=="string"||!/^[-a-zA-Z0-9_]{1,64}$/.test(c.id)||
       typeof c.token!=="string"||!/^[A-Za-z0-9_-]{32,128}$/.test(c.token))||
     !/^[A-Za-z0-9_-]{32,128}$/.test(internalApiToken)||
     !Number.isSafeInteger(internalApiPort)||internalApiPort<1||internalApiPort>65535||
     !auditDb||typeof auditDb.query!=="function")
    throw new TypeError("gateway_config_invalid");
  const peers=clients.map(c=>({role:c.role,principalHash:digest(c.id).toString("hex"),tokenHash:digest(c.token)}));
  if(new Set(peers.map(x=>x.tokenHash.toString("hex"))).size!==peers.length)
    throw new TypeError("gateway_ambiguous_credentials");
  let inFlight=0;
  const server=http.createServer(async(req,res)=>{
    const requestId=randomUUID();
    let principal=null,route=null;
    if(!req.url||req.url.length>2048){reply(res,414,{error:"request_target_too_long"});return;}
    try{
      const raw=req.headers.authorization;
      const valid=typeof raw==="string"&&/^Bearer [A-Za-z0-9_-]{32,128}$/.test(raw)&&
        req.rawHeaders.filter((value,i)=>i%2===0&&value.toLowerCase()==="authorization").length===1;
      if(valid){
        const candidate=digest(raw.slice(7));
        principal=peers.find(p=>timingSafeEqual(p.tokenHash,candidate))??null;
      }
      try{route=parseApiRequest(req.url,now())}catch{route=null}
      const forbidden=!!(principal&&route&&["signals","backtest"].includes(route.kind)&&principal.role!=="analyst");
      const status=!principal?401:forbidden?403:req.method!=="GET"?405:
        !route?404:req.headers["transfer-encoding"]!==undefined||
        (req.headers["content-length"]!==undefined&&req.headers["content-length"]!=="0")?400:
        inFlight>=8?503:200;
      // One audit row per decision, before forwarding any bytes.
      await auditDb.query(`INSERT INTO gateway_auth_log(request_id,principal_hash,role,operation,allowed,denial_code)
        VALUES($1,$2,$3,$4,$5,$6)`,[
        requestId,principal?.principalHash??null,principal?.role??null,
        route?.kind??"unmatched",status===200,status===200?null:
          ({401:"unauthorized",403:"forbidden",404:"not_found",405:"method_not_allowed",
            400:"invalid_body",503:"capacity_exhausted"})[status]??"request_rejected",
      ]);
      if(status!==200){reply(res,status,{error:status===401?"unauthorized":status===403?"forbidden":"invalid_request"});return}
      inFlight++;
      try{
        const upstream=await fetchImpl(BASE+internalApiPort+req.url,{
          method:"GET",headers:{"Authorization":"Bearer "+internalApiToken,
            "Accept":"application/json"},redirect:"error",signal:AbortSignal.timeout(7000),
        });
        if(!upstream.headers.get("content-type")?.startsWith("application/json")){
          reply(res,502,{error:"upstream_invalid_content_type"});return;
        }
        let body;
        try{body=await boundedJsonResponse(upstream)}
        catch{reply(res,502,{error:"upstream_response_invalid"});return}
        reply(res,upstream.status>=200&&upstream.status<=599?upstream.status:502,body);
      }catch{reply(res,503,{error:"intelligence_upstream_unavailable"})}
      finally{inFlight--}
    }catch{
      // Audit failures are fail-closed. Never reveal database errors or tokens.
      reply(res,503,{error:"gateway_audit_unavailable"});
    }
  });
  server.requestTimeout=10000;server.headersTimeout=8000;
  server.keepAliveTimeout=3000;server.maxHeadersCount=32;
  return server;
}
