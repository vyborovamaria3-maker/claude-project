// data-tag: api.trade.pumpfun-feed
// Fetches NEW / BONDING / GRADUATED pump.fun tokens via Moralis Solana Gateway.
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const MORALIS_API_KEY = process.env.MORALIS_API_KEY || "";

type FeedType = "new" | "bonding" | "graduated";

interface PumpToken {
  mint: string;
  name: string;
  symbol: string;
  logo: string | null;
  priceUsd: number | null;
  liquidity: number | null;
  fdv: number | null;
  createdAt: string | null;
  type: FeedType;
}

const cache: Record<FeedType, { data: PumpToken[]; ts: number }> = {
  new: { data: [], ts: 0 },
  bonding: { data: [], ts: 0 },
  graduated: { data: [], ts: 0 },
};
const CACHE_MS = 30_000;

async function fetchFeed(type: FeedType, limit: number): Promise<PumpToken[]> {
  if (!MORALIS_API_KEY) return [];
  const now = Date.now();
  if (cache[type].data.length > 0 && now - cache[type].ts < CACHE_MS) {
    return cache[type].data.slice(0, limit);
  }
  try {
    const r = await fetch(
      `https://solana-gateway.moralis.io/token/mainnet/exchange/pumpfun/${type}?limit=${limit}`,
      {
        headers: { "X-API-Key": MORALIS_API_KEY, Accept: "application/json" },
        cache: "no-store",
      }
    );
    if (!r.ok) return [];
    const d = await r.json();
    const items = Array.isArray(d) ? d : d.result || d.tokens || [];
    const tokens: PumpToken[] = items.map((t: any) => ({
      mint: t.tokenAddress || t.mint || "",
      name: t.name || "",
      symbol: t.symbol || "",
      logo: t.logo || null,
      priceUsd: t.priceUsd ? Number(t.priceUsd) : null,
      liquidity: t.liquidity ? Number(t.liquidity) : null,
      fdv: t.fullyDilutedValuation ? Number(t.fullyDilutedValuation) : null,
      createdAt: t.createdAt || null,
      type,
    })).filter((t: PumpToken) => t.mint);
    cache[type] = { data: tokens, ts: now };
    return tokens.slice(0, limit);
  } catch {
    return [];
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const type = (searchParams.get("type") as FeedType) || "new";
  const limit = Math.min(Number(searchParams.get("limit") || 50), 200);

  if (!["new", "bonding", "graduated"].includes(type)) {
    return NextResponse.json({ error: "invalid type" }, { status: 400 });
  }

  const tokens = await fetchFeed(type, limit);
  return NextResponse.json({ type, count: tokens.length, tokens });
}
