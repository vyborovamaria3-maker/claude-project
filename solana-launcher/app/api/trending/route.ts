import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_TTL = 30_000;
const cache = new Map<string, { data: TrendingToken[]; timestamp: number }>();

export type TrendingToken = {
  id: string;
  ticker: string;
  name: string;
  price: string;
  changePct: number;
  icon: string;
  mint: string;
};

type DexPair = {
  chainId: string;
  baseToken: { address: string; name: string; symbol: string };
  priceUsd?: string;
  priceNative?: string;
  priceChange?: { h24?: number };
  volume?: { h24?: number };
  liquidity?: { usd?: number };
};

async function fetchTrendingFromDexScreener(): Promise<TrendingToken[]> {
  // DexScreener: top gainers on Solana in last 24h
  const r = await fetch(
    "https://api.dexscreener.com/token-boosts/top/v1",
    { headers: { Accept: "application/json" }, cache: "no-store" }
  );
  if (!r.ok) throw new Error(`DexScreener ${r.status}`);
  type BoostItem = { tokenAddress: string; chainId: string; description?: string };
  const boosts = (await r.json()) as BoostItem[];
  const solBoosts = boosts.filter(b => b.chainId === "solana").slice(0, 10);
  if (solBoosts.length === 0) return [];

  const mints = solBoosts.map(b => b.tokenAddress).join(",");
  const r2 = await fetch(
    `https://api.dexscreener.com/latest/dex/tokens/${mints}`,
    { headers: { Accept: "application/json" }, cache: "no-store" }
  );
  if (!r2.ok) throw new Error(`DexScreener tokens ${r2.status}`);
  const data = (await r2.json()) as { pairs?: DexPair[] };
  const pairs = (data.pairs ?? []).filter(p => p.chainId === "solana");

  // Deduplicate by mint, pick most liquid pair per token
  const byMint = new Map<string, DexPair>();
  for (const p of pairs) {
    const mint = p.baseToken.address;
    const existing = byMint.get(mint);
    if (!existing || (p.liquidity?.usd ?? 0) > (existing.liquidity?.usd ?? 0)) {
      byMint.set(mint, p);
    }
  }

  return Array.from(byMint.values())
    .sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0))
    .slice(0, 8)
    .map(p => {
      const symbol = p.baseToken.symbol;
      const priceUsd = p.priceUsd ? parseFloat(p.priceUsd) : 0;
      const priceStr = priceUsd >= 1
        ? `$${priceUsd.toFixed(2)}`
        : priceUsd >= 0.001
          ? `$${priceUsd.toFixed(5)}`
          : `$${priceUsd.toExponential(2)}`;
      return {
        id: p.baseToken.address,
        mint: p.baseToken.address,
        ticker: `$${symbol}`,
        name: p.baseToken.name,
        price: priceStr,
        changePct: p.priceChange?.h24 ?? 0,
        icon: symbol.slice(0, 2).toUpperCase(),
      };
    });
}

export async function GET() {
  const cached = cache.get("trending");
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return NextResponse.json(cached.data, {
      headers: { "Cache-Control": "public, max-age=30" },
    });
  }

  try {
    const tokens = await fetchTrendingFromDexScreener();
    cache.set("trending", { data: tokens, timestamp: Date.now() });
    return NextResponse.json(tokens, {
      headers: { "Cache-Control": "public, max-age=30" },
    });
  } catch {
    if (cached) {
      return NextResponse.json(cached.data, {
        headers: { "Cache-Control": "public, max-age=10", "X-Stale": "true" },
      });
    }
    return NextResponse.json([], { status: 502 });
  }
}
