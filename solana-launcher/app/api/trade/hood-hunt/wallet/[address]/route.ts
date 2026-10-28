// Read-only indicative assessment of a watched Solana wallet.
// GET /api/trade/hood-hunt/wallet/<address>
// Never route this endpoint to an order executor.
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/trade/db";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";
import { evaluateHoodHuntWallet, type ObservedSwap } from "@/lib/trade/hood-hunt-wallet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_MINTS = 60;
const MAX_SWAPS_PER_MINT = 2000;

type TokenRow = {
  mint: string;
  signature: string;
  legIndex: number;
  timestamp: number;
  trader: string;
  type: string;
  amountSol: number;
  amountTokens: number;
  priceSol: number;
  slot: number | null;
  fee: number | null;
  jitoTipLamports: number | null;
};

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ address: string }> },
) {
  const wallet = (await context.params).address;
  if (!ADDR_RE.test(wallet)) {
    return NextResponse.json({ error: "invalid Solana wallet" }, { status: 400 });
  }
  const rate = checkRateLimit(getClientIp(req as unknown as Request), 15, 60);
  if (!rate.success) {
    return NextResponse.json({ error: "rate limited", retryAfter: rate.retryAfter }, { status: 429 });
  }

  const db = getDb();
  const mints = db.prepare(
    "SELECT mint FROM wallet_token_stats WHERE address=? ORDER BY updated_at DESC LIMIT ?"
  ).all(wallet, MAX_MINTS) as Array<{ mint: string }>;

  const readTrades = db.prepare(
    "SELECT mint,signature,leg_index AS legIndex,timestamp,trader,type,"
    + " amount_sol AS amountSol,amount_tokens AS amountTokens,price_sol AS priceSol,"
    + " slot,fee,jito_tip_lamports AS jitoTipLamports"
    + " FROM token_trade_fills WHERE mint=?"
    + " UNION ALL SELECT old.mint,old.signature,0 AS legIndex,old.timestamp,old.trader,old.type,"
    + " old.amount_sol AS amountSol,old.amount_tokens AS amountTokens,old.price_sol AS priceSol,"
    + " old.slot,old.fee,old.jito_tip_lamports AS jitoTipLamports"
    + " FROM token_trades old WHERE old.mint=?"
    + " AND NOT EXISTS (SELECT 1 FROM token_trade_fills f WHERE f.mint=old.mint AND f.signature=old.signature)"
    + " ORDER BY timestamp DESC LIMIT ?"
  );

  const creatorLookup = db.prepare(
    "SELECT creator FROM dev_tokens WHERE mint=? ORDER BY last_updated_at DESC LIMIT 1"
  );
  const tokenCreators: Record<string, string | null> = {};
  const swaps: ObservedSwap[] = [];
  let truncatedTokens = 0;
  for (const { mint } of mints) {
    const rows = readTrades.all(mint, mint, MAX_SWAPS_PER_MINT) as TokenRow[];
    if (rows.length === MAX_SWAPS_PER_MINT) truncatedTokens++;
    const creator = creatorLookup.get(mint) as { creator: string } | undefined;
    tokenCreators[mint] = creator?.creator ?? null;
    for (const row of rows) {
      if (row.type !== "buy" && row.type !== "sell") continue;
      swaps.push({
        mint: row.mint, signature: row.signature, legIndex: row.legIndex,
        trader: row.trader, side: row.type,
        timestamp: row.timestamp, slot: row.slot,
        amountSol: row.amountSol, amountTokens: row.amountTokens,
        priceSol: row.priceSol,
        feeSol: row.fee != null && row.fee >= 0 && row.fee <= 1 ? row.fee : null,
        tipSol: row.jitoTipLamports != null && row.jitoTipLamports >= 0
          ? row.jitoTipLamports / 1_000_000_000 : null,
      });
    }
  }
  // Neither token creation slot nor current SOL balance may be inferred from a
  // token's first indexed trade. Keep them unknown pending authoritative RPC data.
  const assessment = evaluateHoodHuntWallet({ wallet, trades: swaps, tokenCreators });
  assessment.limitations.push(
    "Only up to " + MAX_MINTS + " locally indexed mints and "
      + MAX_SWAPS_PER_MINT + " most recent swap rows per mint are scanned."
  );
  if (truncatedTokens) {
    assessment.limitations.push(
      String(truncatedTokens) + " token histories reached the row cap and may be incomplete."
    );
  }
  return NextResponse.json({ available: true, assessment, createdSlotsVerified: false }, {
    headers: { "Cache-Control": "private, max-age=0, no-store" },
  });
}
