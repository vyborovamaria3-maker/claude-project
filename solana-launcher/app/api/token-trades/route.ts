import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

// data-tag: api.token_trades
// Proxy to swap-api.pump.fun/v2/coins/{mint}/trades — public, real on-chain.
// frontend-api.pump.fun was used previously but now returns 530 (blocked).
//
// Returns trades normalized to the legacy shape consumed by useTradeStream:
//   { signature, sol_amount (lamports), token_amount (micro-tokens), is_buy,
//     timestamp (unix seconds), user, usd_market_cap?, slot? }

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const tradeCache = new Map<string, { data: unknown[]; ts: number }>();
const CACHE_TTL = 250; // 250ms — low-latency cache for realtime charting
const MAX_TRADE_CACHE_ENTRIES = 2_000;

type V2Trade = {
  tx: string;
  timestamp: string;        // ISO 8601
  userAddress: string;
  type: "buy" | "sell";
  program?: string;
  priceUsd: string;
  amountUsd: string;
  amountSol: string;
  baseAmount: string;        // token units (already decimal-adjusted)
  quoteAmount: string;       // SOL
};

type V2Resp = { trades?: V2Trade[]; pagination?: { hasMore?: boolean; nextCursor?: string } };

function cacheTrades(key: string, data: unknown[]) {
  const now = Date.now();

  if (tradeCache.size >= MAX_TRADE_CACHE_ENTRIES) {
    for (const [candidate, entry] of tradeCache) {
      if (now - entry.ts >= CACHE_TTL) tradeCache.delete(candidate);
    }
  }

  while (tradeCache.size >= MAX_TRADE_CACHE_ENTRIES) {
    const oldest = tradeCache.keys().next().value as string | undefined;
    if (!oldest) break;
    tradeCache.delete(oldest);
  }

  tradeCache.set(key, { data, ts: now });
}

export async function GET(req: NextRequest) {
  const mint = req.nextUrl.searchParams.get("mint")?.trim() || "";
  const parsedLimit = Number(req.nextUrl.searchParams.get("limit") || 50);
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(Math.trunc(parsedLimit), 100)) : 50;
  if (!mint) return NextResponse.json({ error: "mint required" }, { status: 400 });
  try {
    if (new PublicKey(mint).toBase58() !== mint) throw new Error("non-canonical mint");
  } catch {
    return NextResponse.json({ error: "invalid Solana mint" }, { status: 400 });
  }

  const cacheKey = `${mint}:${limit}`;
  const cached = tradeCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return NextResponse.json(cached.data, { headers: { "Cache-Control": "no-store" } });
  }
  if (cached) tradeCache.delete(cacheKey);

  try {
    const r = await fetch(
      `https://swap-api.pump.fun/v2/coins/${encodeURIComponent(mint)}/trades?limit=${limit}`,
      {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!r.ok) return NextResponse.json([], { status: 200 });
    const data = (await r.json()) as V2Resp;
    const trades = data.trades || [];

    // Normalize to legacy shape — useTradeStream expects sol_amount in lamports,
    // token_amount in micro-tokens, timestamp in unix seconds.
    const normalized = trades.map((trade) => {
      const timestampMs = Date.parse(trade.timestamp);
      return {
        signature: trade.tx,
        sol_amount: Math.round((Number(trade.amountSol) || 0) * 1e9),
        token_amount: Math.round((Number(trade.baseAmount) || 0) * 1e6),
        is_buy: trade.type === "buy",
        timestamp: Number.isFinite(timestampMs) ? Math.floor(timestampMs / 1000) : null,
        user: trade.userAddress,
        priceUsd: Number(trade.priceUsd) || 0,
        amountUsd: Number(trade.amountUsd) || 0,
        program: trade.program,
      };
    });

    cacheTrades(cacheKey, normalized);
    return NextResponse.json(normalized, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json([], { status: 200 });
  }
}
