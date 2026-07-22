import { NextRequest, NextResponse } from "next/server";

// data-tag: api.token_ohlcv
// Proxy to DexScreener (avoids CORS) — returns simplified OHLCV-friendly payload.
// DexScreener gives latest pair data; for true OHLCV we synthesise candles
// on the client side from priceUsd / priceChange snapshots.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30; // allow time for trade pagination

// Server-side cache to reduce DexScreener load
const cache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL = 3_000; // 3s — fast refresh for live mcap

// Separate longer-lived cache for Total Fees (expensive to compute, slow-changing)
const feesCache = new Map<string, { feeSol: number; timestamp: number }>();
const FEES_CACHE_TTL = 60_000; // 60s — fees don’t change second-by-second

interface TradesResult {
  totalSol: number;
  uniqueTraders: number;
}

/**
 * Fetch Total Volume from real on-chain v2/trades data.
 * Returns totalSol and uniqueTraders count.
 * Total Fees = totalSol × 1% (pump.fun fee rate).
 */
async function fetchTradesData(mint: string): Promise<TradesResult | null> {
  const fc = feesCache.get(mint);
  if (fc && Date.now() - fc.timestamp < FEES_CACHE_TTL) return { totalSol: fc.feeSol / 0.01, uniqueTraders: (fc as any).uniqueTraders ?? 0 };

  try {
    const PAGE = 100;
    const MAX_PAGES = 3; // Reduced from 10 to 3 for faster response (300 trades vs 1000)
    const BASE = `https://swap-api.pump.fun/v2/coins/${mint}/trades`;

    type Trade = { amountSol: string; walletAddress?: string; trader?: string };
    type Resp = { trades?: Trade[]; pagination?: { hasMore?: boolean; nextCursor?: string } };

    const r1 = await fetch(`${BASE}?limit=${PAGE}`, {
      headers: { Accept: "application/json" }, cache: "no-store",
    });
    if (!r1.ok) return null;
    const d1 = (await r1.json()) as Resp;
    const pages: Trade[][] = [d1.trades ?? []];

    if (d1.pagination?.hasMore && d1.pagination.nextCursor) {
      let nextCursor: string | undefined = d1.pagination.nextCursor;
      for (let i = 1; i < MAX_PAGES && nextCursor; i++) {
        const rN = await fetch(`${BASE}?limit=${PAGE}&cursor=${encodeURIComponent(nextCursor)}`, {
          headers: { Accept: "application/json" }, cache: "no-store",
        });
        if (!rN.ok) break;
        const dN = (await rN.json()) as Resp;
        pages.push(dN.trades ?? []);
        if (!dN.pagination?.hasMore || !dN.pagination.nextCursor) break;
        nextCursor = dN.pagination.nextCursor;
      }
    }

    let totalSol = 0;
    const wallets = new Set<string>();
    for (const page of pages) {
      for (const t of page) {
        totalSol += Number(t.amountSol) || 0;
        const w = t.walletAddress || t.trader;
        if (w) wallets.add(w);
      }
    }

    if (totalSol <= 0) return null;
    const feeSol = totalSol * 0.01; // 1% pump.fun fee
    const uniqueTraders = wallets.size;
    feesCache.set(mint, { feeSol, timestamp: Date.now(), uniqueTraders } as any);
    return { totalSol, uniqueTraders };
  } catch { return null; }
}

interface BondingCurveInfo {
  progress: number; // 0-100
  migrated: boolean;
  virtualSolReserves: number;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
}

async function fetchPumpInfo(mint: string): Promise<BondingCurveInfo | null> {
  try {
    const r = await fetch(`https://frontend-api.pump.fun/coins/${mint}`, {
      headers: { Accept: "application/json" }, cache: "no-store",
    });
    if (!r.ok) return null;
    const d = await r.json();
    const vSol = Number(d.virtual_sol_reserves) || 0;
    const vToken = Number(d.virtual_token_reserves) || 0;
    const migrated = !!d.complete || !!d.raydium_pool;
    // Bonding curve fills at ~85 SOL virtual reserves (pump.fun spec)
    const progress = migrated ? 100 : Math.min(100, Math.round((vSol / 85_000_000_000) * 100));
    return {
      progress,
      migrated,
      virtualSolReserves: vSol / 1e9,
      twitter: d.twitter ? `https://twitter.com/${d.twitter.replace(/^@/, "").replace(/^https?:\/\/(www\.)?(twitter|x)\.com\//i, "")}` : null,
      telegram: d.telegram ?? null,
      website: d.website ?? null,
    };
  } catch { return null; }
}

type DexPair = {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  priceUsd?: string;
  priceNative?: string;
  fdv?: number;
  marketCap?: number;
  volume?: { h24?: number; h6?: number; h1?: number; m5?: number };
  priceChange?: { h24?: number; h6?: number; h1?: number; m5?: number };
  txns?: Record<string, { buys: number; sells: number }>;
  liquidity?: { usd?: number };
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    websites?: { url: string }[];
    socials?: { type: string; url: string }[];
  };
};

export async function GET(req: NextRequest) {
  const mint = req.nextUrl.searchParams.get("mint");
  if (!mint) {
    return NextResponse.json({ error: "mint required" }, { status: 400 });
  }

  // Check cache first
  const cached = cache.get(mint);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return NextResponse.json(cached.data, {
      headers: { "Cache-Control": "public, max-age=15" }
    });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000); // 8s timeout
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!r.ok) {
      return NextResponse.json({ error: `DexScreener ${r.status}` }, { status: 502 });
    }
    const data = (await r.json()) as { pairs?: DexPair[] };

    // pick the most liquid Solana pair where our mint is the base token
    const mintLower = mint.toLowerCase();
    const solPairs = (data.pairs ?? []).filter(
      p => p.chainId === "solana" && p.baseToken.address.toLowerCase() === mintLower
    );

    // If not on DexScreener yet — try Pump.fun swap-api v1 directly
    if (solPairs.length === 0) {
      try {
        const pr = await fetch(`https://swap-api.pump.fun/v1/coins/${mint}`, {
          headers: { Accept: "application/json" }, cache: "no-store",
        });
        if (pr.ok) {
          type PumpCoin = { symbol: string; name: string; usdMarketCap?: number; priceUsd?: string };
          const coin = (await pr.json()) as PumpCoin;
          const mcap = coin.usdMarketCap ?? null;
          const priceUsd = coin.priceUsd ? parseFloat(coin.priceUsd) : null;
          const responseData = {
            pair: {
              dexId: "pumpfun", pairAddress: mint,
              symbol: coin.symbol ?? "", name: coin.name ?? "",
              priceUsd, priceNative: null,
              fdv: mcap, marketCap: mcap,
              volumeH24: 0, change24h: 0, liquidityUsd: 0, createdAt: null,
              totalVolumeSol: null, totalVolumeUsd: null, solPrice: null,
            },
          };
          cache.set(mint, { data: responseData, timestamp: Date.now() });
          return NextResponse.json(responseData, { headers: { "Cache-Control": "no-store" } });
        }
      } catch { /* ignore */ }
      return NextResponse.json({ error: "no_pairs", pairs: [] });
    }

    const best = solPairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];

    const nativeSolPrice = (best.priceUsd && best.priceNative)
      ? parseFloat(best.priceUsd) / parseFloat(best.priceNative)
      : 0;
    const solPrice = nativeSolPrice || 150;

    // Fetch trades data and pump.fun info in parallel
    const [tradesData, pumpInfo] = await Promise.all([
      fetchTradesData(mint),
      fetchPumpInfo(mint),
    ]);

    const totalVolumeSol = tradesData?.totalSol ?? null;
    const totalFeesSol = totalVolumeSol ? totalVolumeSol * 0.01 : null; // 1% pump.fun fee
    const totalVolumeUsd = totalVolumeSol ? totalVolumeSol * solPrice : null;
    const uniqueTraders = tradesData?.uniqueTraders ?? null;

    // Socials: prefer DexScreener info, fallback to pump.fun
    const dexTwitter = best.info?.socials?.find(s => s.type === "twitter")?.url ?? null;
    const dexTelegram = best.info?.socials?.find(s => s.type === "telegram")?.url ?? null;
    const dexWebsite = best.info?.websites?.[0]?.url ?? null;
    const twitter = dexTwitter || pumpInfo?.twitter || null;
    const telegram = dexTelegram || pumpInfo?.telegram || null;
    const website = dexWebsite || pumpInfo?.website || null;

    const responseData = {
      pair: {
        dexId: best.dexId,
        pairAddress: best.pairAddress,
        symbol: best.baseToken.symbol,
        name: best.baseToken.name,
        priceUsd: best.priceUsd ? parseFloat(best.priceUsd) : null,
        priceNative: best.priceNative ? parseFloat(best.priceNative) : null,
        fdv: best.fdv ?? null,
        marketCap: best.marketCap ?? null,
        volumeH24: best.volume?.h24 ?? 0,
        volumeH6: best.volume?.h6 ?? 0,
        volumeH1: best.volume?.h1 ?? 0,
        volumeM5: best.volume?.m5 ?? 0,
        change24h: best.priceChange?.h24 ?? 0,
        changeH1: best.priceChange?.h1 ?? 0,
        buysH1: best.txns?.h1?.buys ?? 0,
        sellsH1: best.txns?.h1?.sells ?? 0,
        buysH24: best.txns?.h24?.buys ?? 0,
        sellsH24: best.txns?.h24?.sells ?? 0,
        liquidityUsd: best.liquidity?.usd ?? 0,
        liquidity: best.liquidity?.usd ?? 0,
        createdAt: best.pairCreatedAt ?? null,
        totalVolumeSol,
        totalFeesSol,
        totalVolumeUsd: totalVolumeUsd ?? null,
        solPrice: solPrice || null,
        uniqueTraders,
        bcProgress: pumpInfo?.progress ?? null,
        bcMigrated: pumpInfo?.migrated ?? null,
        twitter,
        telegram,
        website,
      },
    };
    
    cache.set(mint, { data: responseData, timestamp: Date.now() });
    return NextResponse.json(responseData, { headers: { "Cache-Control": "no-store" } });
  } catch (e: any) {
    if (cached) {
      return NextResponse.json(cached.data, {
        headers: { "Cache-Control": "no-store", "X-Stale": "true" }
      });
    }
    return NextResponse.json({ error: e?.message ?? "fetch_failed" }, { status: 500 });
  }
}
