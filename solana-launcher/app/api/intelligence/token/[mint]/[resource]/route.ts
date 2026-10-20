import {NextRequest,NextResponse} from "next/server";
import {PublicKey} from "@solana/web3.js";
import {requireProdAuth} from "@/lib/routeAuth";
import {checkRateLimit,getClientIp} from "@/lib/rateLimit";
import {
  SafeProxyError,assertMintShape,parseClientTokenQuery,fetchTokenIntelligence,
} from "@/lib/token-intelligence/proxy-core.mjs";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export const revalidate=0;

const RESPONSE_HEADERS={
  "Cache-Control":"private, no-store, max-age=0",
  "X-Content-Type-Options":"nosniff",
  "Referrer-Policy":"no-referrer",
};
function fail(code:string,status:number){
  return NextResponse.json({error:code},{status,headers:RESPONSE_HEADERS});
}
export async function GET(
  request:NextRequest,
  context:{params:Promise<{mint:string;resource:string}>},
){
  // Browser never sees INTELLIGENCE_API_TOKEN. POTAPoff's existing session /
  // subscription authorization is mandatory in production, BEFORE proxying.
  const auth=await requireProdAuth(request);
  if(auth)return auth;
  if(process.env.POTAPOFF_TOKEN_INTELLIGENCE_ENABLED!=="true")
    return fail("feature_disabled",503);
  const limit=checkRateLimit(
    "intelligence-token:"+getClientIp(request as unknown as Request),20,60,
  );
  if(!limit.success){
    return NextResponse.json({error:"rate_limited"},{status:429,headers:{
      ...RESPONSE_HEADERS,"Retry-After":String(limit.retryAfter??60),
    }});
  }
  try{
    const {mint,resource}=await context.params;
    assertMintShape(mint);
    try{
      if(new PublicKey(mint).toBase58()!==mint)throw new Error("mint_noncanonical");
    }catch{throw new SafeProxyError("invalid_mint",400);}
    if(resource!=="links"&&resource!=="timeline"){
      return fail("not_found",404);
    }
    const query=parseClientTokenQuery(request.nextUrl.search,new Date());
    const projected=await fetchTokenIntelligence(mint,resource,query);
    return NextResponse.json(projected,{headers:RESPONSE_HEADERS});
  }catch(error){
    if(error instanceof SafeProxyError)return fail(error.code,error.status);
    // No raw upstream errors, internal URLs, Bearer secrets, tokens or DSNs.
    return fail("intelligence_unavailable",503);
  }
}
