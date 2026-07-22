import { NextRequest, NextResponse } from "next/server";

// data-tag: api.token_pool
// All pools/pairs for a token from DexScreener

export const runtime = "edge";

export async function GET(req: NextRequest) {
  const mint = req.nextUrl.searchParams.get("mint");
  if (!mint) return NextResponse.json({ error: "mint required" }, { status: 400 });

  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!r.ok) return NextResponse.json({ error: `dex_${r.status}`, pools: [] }, { status: 502 });
    const data = await r.json();
    const pairs = (data.pairs ?? []).filter((p: { chainId: string }) => p.chainId === "solana");
    const pools = pairs.map((p: {
      dexId: string;
      pairAddress: string;
      baseToken: { symbol: string };
      quoteToken: { symbol: string; address: string };
      priceUsd?: string;
      liquidity?: { usd?: number; base?: number; quote?: number };
      volume?: { h24?: number };
      txns?: Record<string, { buys: number; sells: number }>;
      pairCreatedAt?: number;
      url?: string;
    }) => ({
      dexId: p.dexId,
      pairAddress: p.pairAddress,
      base: p.baseToken.symbol,
      quote: p.quoteToken.symbol,
      priceUsd: p.priceUsd ? parseFloat(p.priceUsd) : 0,
      liquidityUsd: p.liquidity?.usd ?? 0,
      liquidityBase: p.liquidity?.base ?? 0,
      liquidityQuote: p.liquidity?.quote ?? 0,
      volume24h: p.volume?.h24 ?? 0,
      buys24h: p.txns?.h24?.buys ?? 0,
      sells24h: p.txns?.h24?.sells ?? 0,
      createdAt: p.pairCreatedAt ?? null,
      url: p.url,
    }));
    return NextResponse.json({ pools });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "fetch_failed";
    return NextResponse.json({ error: msg, pools: [] }, { status: 500 });
  }
}
