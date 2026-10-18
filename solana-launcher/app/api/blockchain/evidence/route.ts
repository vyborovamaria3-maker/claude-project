import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { requireProdAuth } from "@/lib/routeAuth";
import { getDb } from "@/lib/trade/db";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";
import { REVISION as FORENSIC_REVISION } from "../../../../scripts/blockchain-forensics.cjs";
import { REVISION as DEX_REVISION } from "../../../../scripts/blockchain-dex-index.cjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only forensic view of persisted Helius evidence. Never merges the
// migration/Excel labels or legacy synthetic pnl into on-chain proof.
function validAddress(value: string): boolean {
  try { return new PublicKey(value).toBase58() === value; } catch { return false; }
}
function hasTable(db: ReturnType<typeof getDb>, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
function safeJsonReasons(value: string): string[] {
  try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : ["bad_metadata"]; }
  catch { return ["bad_metadata"]; }
}
type PnlRow = { wallet:string; mint:string; status:string; coverage_complete:number; buys:number; sells:number;
  transfers:number; known_sells:number; known_realized_pnl_sol:number|null; total_realized_pnl_sol:number|null;
  unknown_reasons:string; updated_at:number };
function mapPnl(row: PnlRow) {
  return {wallet:row.wallet,mint:row.mint,status:row.status,
    coverageComplete:row.coverage_complete===1,buys:row.buys,sells:row.sells,transfers:row.transfers,
    knownSells:row.known_sells,knownRealizedPnlSol:row.known_realized_pnl_sol,
    totalRealizedPnlSol:row.status==="verified" && row.coverage_complete===1 ? row.total_realized_pnl_sol : null,
    unknownReasons:safeJsonReasons(row.unknown_reasons),updatedAt:row.updated_at};
}
export async function GET(req: NextRequest) {
  const auth=await requireProdAuth(req);
  if (auth) return auth;
  const rate=checkRateLimit(getClientIp(req as unknown as Request),30,60);
  if(!rate.success) return NextResponse.json({error:"Rate limit exceeded"},{
    status:429,headers:{"Retry-After":String(rate.retryAfter||60),"Cache-Control":"no-store"}
  });
  const wallet=(req.nextUrl.searchParams.get("wallet")||"").trim();
  const mint=(req.nextUrl.searchParams.get("mint")||"").trim();
  if ((!wallet && !mint) || (wallet && mint) ||
      (wallet && !validAddress(wallet)) || (mint && !validAddress(mint))) {
    return NextResponse.json({error:"Specify exactly one canonical Solana wallet or mint"}, {status:400});
  }
  const paramLimit=Number(req.nextUrl.searchParams.get("limit")||50);
  if (!Number.isSafeInteger(paramLimit) || paramLimit<1 || paramLimit>100) {
    return NextResponse.json({error:"limit must be integer 1..100"},{status:400});
  }
  const db=getDb();
  const forensic=hasTable(db,"chain_forensic_wallet_pnl") && hasTable(db,"chain_forensic_wallet_sync");
  const dex=hasTable(db,"chain_dex_observed_trades") && hasTable(db,"chain_dex_indexed_signatures");
  const sources=hasTable(db,"chain_seed_targets") ? db.prepare(
    "SELECT address,backfill_complete,possible_gap,forward_cursor,last_success_at,last_error FROM chain_seed_targets WHERE kind='dex_program' AND source_mask<>0 ORDER BY priority DESC,address LIMIT 8"
  ).all() : [];
  const meta={source:"persisted_helius_onchain",coverage:"observed_seeds_and_configured_dex_programs_only",
    globallyComplete:false,verifiedGlobalPnl:false,observationsBounded:true,forensicIndexAvailable:forensic,
    dexIndexAvailable:dex,dexPrograms:sources};
  if (wallet) {
    const sync=forensic?db.prepare(
      "SELECT revision,observed_count,coverage_complete,analyzed_at FROM chain_forensic_wallet_sync WHERE wallet=?"
    ).get(wallet):null;
    const pnl=forensic?db.prepare(
      "SELECT p.* FROM chain_forensic_wallet_pnl p JOIN chain_forensic_wallet_sync s ON s.wallet=p.wallet WHERE p.wallet=? AND s.revision=? ORDER BY (p.status='verified') DESC,p.updated_at DESC,p.mint LIMIT ?"
    ).all(wallet,FORENSIC_REVISION,paramLimit) as PnlRow[]:[];
    const activities=forensic && hasTable(db,"chain_forensic_activities")?db.prepare(
      "SELECT a.wallet,a.signature,a.slot,a.block_time,a.kind,a.mint,a.amount_tokens,a.amount_sol,a.fee_sol,a.counterparty FROM chain_forensic_activities a JOIN chain_forensic_wallet_sync s ON s.wallet=a.wallet WHERE a.wallet=? AND s.revision=? ORDER BY a.slot DESC LIMIT ?"
    ).all(wallet,FORENSIC_REVISION,paramLimit):[];
    const relations=hasTable(db,"chain_forensic_edges")?db.prepare(
      "SELECT DISTINCT signature,mint,from_wallet,to_wallet,amount_tokens FROM chain_forensic_edges WHERE observer_wallet=? LIMIT ?"
    ).all(wallet,paramLimit):[];
    return NextResponse.json({mode:"wallet",wallet,meta,sync:sync||null,
      pnl:pnl.map(mapPnl),activities,relations,
      note:"Wallet transfer edges prove movement, not shared ownership."},
    {headers:{"Cache-Control":"no-store"}});
  }
  const pnl=forensic?db.prepare(
    "SELECT p.* FROM chain_forensic_wallet_pnl p JOIN chain_forensic_wallet_sync s ON s.wallet=p.wallet WHERE p.mint=? AND s.revision=? ORDER BY p.updated_at DESC,p.wallet LIMIT ?"
  ).all(mint,FORENSIC_REVISION,paramLimit) as PnlRow[]:[];
  // Multiple DEX programs can observe one tx. Collapse those observations
  // without claiming the selected programs cover every exchange or venue.
  const observed=dex?db.prepare(
    "SELECT signature,wallet,mint,side,slot,block_time,amount_tokens,amount_sol,fee_sol,program FROM ("+
    " SELECT *,ROW_NUMBER() OVER (PARTITION BY signature,wallet,mint,side ORDER BY program) AS rnk"+
    " FROM (SELECT d.* FROM chain_dex_observed_trades d JOIN chain_dex_indexed_signatures s ON s.program=d.program AND s.signature=d.signature WHERE d.mint=? AND s.revision=? ORDER BY d.slot DESC LIMIT ?)" +
    " ) WHERE rnk=1 ORDER BY slot DESC LIMIT ?"
  ).all(mint,DEX_REVISION,Math.max(200,paramLimit*10),paramLimit):[];
  const seeded=forensic && hasTable(db,"chain_forensic_activities")?db.prepare(
    "SELECT a.signature,a.wallet,a.mint,a.kind AS side,a.slot,a.block_time,a.amount_tokens,a.amount_sol FROM chain_forensic_activities a "+
    "WHERE a.mint=? AND a.kind IN ('buy','sell') AND EXISTS (SELECT 1 FROM chain_forensic_wallet_sync s WHERE s.wallet=a.wallet AND s.revision=?) AND NOT EXISTS ("+
    "SELECT 1 FROM chain_forensic_activities b WHERE b.wallet=a.wallet AND b.signature=a.signature AND b.mint=a.mint AND b.kind='unpriced') "+
    "ORDER BY a.slot DESC LIMIT ?"
  ).all(mint,FORENSIC_REVISION,paramLimit):[];
  return NextResponse.json({mode:"mint",mint,meta,observedDexTrades:observed,seedWalletTrades:seeded,
    walletPnl:pnl.map(mapPnl),note:"Observed trades are NOT a complete token trade tape. Missing wallets, DEX venues and unpriced legs remain unknown."},
  {headers:{"Cache-Control":"no-store"}});
}
