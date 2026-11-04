import {NextRequest,NextResponse} from "next/server";
import {PublicKey} from "@solana/web3.js";
import {requireProdAuth} from "@/lib/routeAuth";
import {readTokenCampaigns,readCampaignEvidence} from "@/lib/trade/token-campaigns.mjs";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(req:NextRequest){
 const denied=await requireProdAuth(req);if(denied)return denied;
 const mint=req.nextUrl.searchParams.get("mint")?.trim()||"";
 try{if(new PublicKey(mint).toBase58()!==mint)throw Error();}catch{return NextResponse.json({error:"invalid_mint"},{status:400});}
 const sha=req.nextUrl.searchParams.get("evidence");
 if(sha){try{return NextResponse.json(await readCampaignEvidence(mint,sha),{headers:{"Cache-Control":"private, no-store"}});}catch{return NextResponse.json({error:"campaign_evidence_unavailable"},{status:404});}}
 return NextResponse.json(await readTokenCampaigns(mint),{headers:{"Cache-Control":"private, no-store"}});
}
