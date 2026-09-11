import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

// data-tag: api.token_trades
// Proxy to swap-api.pump.fun/v2/coins/{mint}/trades — public, real on-chain.
// frontend-api.pump.fun was used previously but now returns 530 (blocked).
//
// Returns trades normalized to the legacy shape consumed by useTradeStream:
//   { signature, sol_amount (lamports), token_amount (micro-tokens), is_buy,
//     timestamp (unix seconds), user, priceUsd?, amountUsd?, slot? }

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const tradeCache = new Map<string, { data: unknown[]; ts: number }>();
const CACHE_TTL = 250; // 250ms — low-latency cache for realtime charting
const UPSTREAM_TIMEOUT_MS = 5_000;

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

  try {
    const r = await fetch(
      `https://swap-api.pump.fun/v2/coins/${encodeURIComponent(mint)}/trades?limit=${limit}`,
      {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      },
    );
    if (!r.ok) {
      return NextResponse.json(
        { error: "pumpfun trades upstream unavailable", upstreamStatus: r.status },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }

    const data = (await r.json()) as V2Resp;
    if (!data || (data.trades != null && !Array.isArray(data.trades))) {
      return NextResponse.json(
        { error: "pumpfun trades upstream returned invalid payload" },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }
    const trades = data.trades || [];

    // Normalize to legacy shape — useTradeStream expects sol_amount in lamports,
    // token_amount in micro-tokens, timestamp in unix seconds.
    const normalized = trades.map((t) => {
      const timestampMs = Date.parse(t.timestamp);
      return {
        signature: t.tx,
        sol_amount: Math.round((Number(t.amountSol) || 0) * 1e9),
        token_amount: Math.round((Number(t.baseAmount) || 0) * 1e6),
        is_buy: t.type === "buy",
        timestamp: Number.isFinite(timestampMs) ? Math.floor(timestampMs / 1000) : null,
        user: t.userAddress,
        priceUsd: Number(t.priceUsd) || 0,
        amountUsd: Number(t.amountUsd) || 0,
        program: t.program,
      };
    });

    tradeCache.set(cacheKey, { data: normalized, ts: Date.now() });
    return NextResponse.json(normalized, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return NextResponse.json(
      { error: timeout ? "pumpfun trades upstream timeout" : "pumpfun trades upstream request failed" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
