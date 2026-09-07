import { NextRequest, NextResponse } from "next/server";
import { requireProdAuth } from "@/lib/routeAuth";

// data-tag: api.token_ohlcv
// Latest pair snapshot for analysis. This is not historical OHLCV.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const cache = new Map<string, { data: unknown; timestamp: number }>();
const CACHE_TTL = 3_000;
const MAX_CACHE_ENTRIES = 256;
const feesCache = new Map<
  string,
  { feeSol: number; uniqueTraders: number; timestamp: number }
>();
const FEES_CACHE_TTL = 60_000;
const MAX_FEES_CACHE_ENTRIES = 512;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const UPSTREAM_TIMEOUT_MS = 8_000;

function setBoundedCache<V>(target: Map<string, V>, key: string, value: V, maxEntries: number) {
  target.delete(key);
  while (target.size >= maxEntries) {
    const oldest = target.keys().next().value as string | undefined;
    if (!oldest) break;
    target.delete(oldest);
  }
  target.set(key, value);
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
}

interface TradesResult {
  totalSol: number;
  uniqueTraders: number;
}

async function fetchTradesData(mint: string): Promise<TradesResult | null> {
  const cached = feesCache.get(mint);
  if (cached && Date.now() - cached.timestamp < FEES_CACHE_TTL) {
    return {
      totalSol: cached.feeSol / 0.01,
      uniqueTraders: cached.uniqueTraders,
    };
  }
  if (cached) feesCache.delete(mint);

  try {
    const pageSize = 100;
    const maxPages = 3;
    const base = `https://swap-api.pump.fun/v2/coins/${encodeURIComponent(mint)}/trades`;
    type Trade = {
      amountSol: string;
      walletAddress?: string;
      trader?: string;
    };
    type Resp = {
      trades?: Trade[];
      pagination?: { hasMore?: boolean; nextCursor?: string };
    };

    const first = await fetchWithTimeout(`${base}?limit=${pageSize}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!first.ok) return null;
    const firstData = (await first.json()) as Resp;
    const pages: Trade[][] = [firstData.trades ?? []];
    let nextCursor = firstData.pagination?.hasMore
      ? firstData.pagination.nextCursor
      : undefined;

    for (let index = 1; index < maxPages && nextCursor; index += 1) {
      const response = await fetchWithTimeout(
        `${base}?limit=${pageSize}&cursor=${encodeURIComponent(nextCursor)}`,
        { headers: { Accept: "application/json" }, cache: "no-store" },
      );
      if (!response.ok) break;
      const data = (await response.json()) as Resp;
      pages.push(data.trades ?? []);
      nextCursor = data.pagination?.hasMore
        ? data.pagination.nextCursor
        : undefined;
    }

    let totalSol = 0;
    const wallets = new Set<string>();
    for (const page of pages) {
      for (const trade of page) {
        totalSol += Number(trade.amountSol) || 0;
        const wallet = trade.walletAddress || trade.trader;
        if (wallet) wallets.add(wallet);
      }
    }
    if (totalSol <= 0) return null;

    setBoundedCache(
      feesCache,
      mint,
      {
        feeSol: totalSol * 0.01,
        uniqueTraders: wallets.size,
        timestamp: Date.now(),
      },
      MAX_FEES_CACHE_ENTRIES,
    );
    return { totalSol, uniqueTraders: wallets.size };
  } catch {
    return null;
  }
}

interface BondingCurveInfo {
  progress: number;
  migrated: boolean;
  virtualSolReserves: number;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
}

async function fetchPumpInfo(mint: string): Promise<BondingCurveInfo | null> {
  try {
    const response = await fetchWithTimeout(
      `https://frontend-api.pump.fun/coins/${encodeURIComponent(mint)}`,
      { headers: { Accept: "application/json" }, cache: "no-store" },
    );
    if (!response.ok) return null;
    const data = await response.json();
    const virtualSol = Number(data.virtual_sol_reserves) || 0;
    const migrated = Boolean(data.complete || data.raydium_pool);
    const progress = migrated
      ? 100
      : Math.min(100, Math.round((virtualSol / 85_000_000_000) * 100));
    return {
      progress,
      migrated,
      virtualSolReserves: virtualSol / 1e9,
      twitter: data.twitter
        ? `https://twitter.com/${String(data.twitter)
            .replace(/^@/, "")
            .replace(/^https?:\/\/(www\.)?(twitter|x)\.com\//i, "")}`
        : null,
      telegram: data.telegram ?? null,
      website: data.website ?? null,
    };
  } catch {
    return null;
  }
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

function response(data: unknown) {
  return NextResponse.json(data, {
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  });
}

export async function GET(req: NextRequest) {
  const authError = await requireProdAuth(req);
  if (authError) return authError;

  const mint = req.nextUrl.searchParams.get("mint")?.trim() || "";
  if (!SOLANA_ADDRESS_RE.test(mint)) {
    return NextResponse.json({ error: "invalid mint" }, { status: 400 });
  }

  const cached = cache.get(mint);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    const value = cached.data as Record<string, unknown>;
    return response({
      ...value,
      meta: {
        ...((value.meta as Record<string, unknown> | undefined) || {}),
        cache: "memory",
        stale: false,
        servedAt: Date.now(),
      },
    });
  }
  if (cached) cache.delete(mint);

  try {
    const upstream = await fetchWithTimeout(
      `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`,
      {
        headers: { Accept: "application/json" },
        cache: "no-store",
      },
    );
    if (!upstream.ok) {
      return NextResponse.json(
        { error: `DexScreener ${upstream.status}` },
        { status: 502 },
      );
    }
    const data = (await upstream.json()) as { pairs?: DexPair[] };
    const mintLower = mint.toLowerCase();
    const solPairs = (data.pairs ?? []).filter(
      (pair) => pair.chainId === "solana"
        && pair.baseToken.address.toLowerCase() === mintLower,
    );

    if (solPairs.length === 0) {
      try {
        const pump = await fetchWithTimeout(
          `https://swap-api.pump.fun/v1/coins/${encodeURIComponent(mint)}`,
          { headers: { Accept: "application/json" }, cache: "no-store" },
        );
        if (pump.ok) {
          type PumpCoin = {
            symbol: string;
            name: string;
            usdMarketCap?: number;
            priceUsd?: string;
          };
          const coin = (await pump.json()) as PumpCoin;
          const marketCap = coin.usdMarketCap ?? null;
          const priceUsd = coin.priceUsd ? Number.parseFloat(coin.priceUsd) : null;
          const responseData = {
            pair: {
              dexId: "pumpfun",
              pairAddress: mint,
              symbol: coin.symbol ?? "",
              name: coin.name ?? "",
              priceUsd: Number.isFinite(priceUsd) ? priceUsd : null,
              priceNative: null,
              fdv: marketCap,
              marketCap,
              volumeH24: null,
              volumeH6: null,
              volumeH1: null,
              volumeM5: null,
              change24h: null,
              changeH1: null,
              liquidityUsd: null,
              createdAt: null,
              createdAtSemantics: "unknown",
              totalVolumeSol: null,
              totalVolumeUsd: null,
              solPrice: null,
            },
            meta: {
              source: "pumpfun-v1-fallback",
              stale: false,
              fetchedAt: Date.now(),
              servedAt: Date.now(),
            },
          };
          setBoundedCache(cache, mint, { data: responseData, timestamp: Date.now() }, MAX_CACHE_ENTRIES);
          return response(responseData);
        }
      } catch {
        // Fall through to no-pairs response.
      }
      return response({ error: "no_pairs", pairs: [] });
    }

    const best = [...solPairs].sort(
      (left, right) => (right.liquidity?.usd ?? 0) - (left.liquidity?.usd ?? 0),
    )[0];
    const parsedPriceUsd = best.priceUsd ? Number.parseFloat(best.priceUsd) : null;
    const parsedPriceNative = best.priceNative
      ? Number.parseFloat(best.priceNative)
      : null;
    const nativeSolPrice = parsedPriceUsd != null
      && parsedPriceNative != null
      && Number.isFinite(parsedPriceUsd)
      && Number.isFinite(parsedPriceNative)
      && parsedPriceNative > 0
      ? parsedPriceUsd / parsedPriceNative
      : null;

    const [tradesData, pumpInfo] = await Promise.all([
      fetchTradesData(mint),
      fetchPumpInfo(mint),
    ]);
    const totalVolumeSol = tradesData?.totalSol ?? null;
    const totalFeesSol = totalVolumeSol != null ? totalVolumeSol * 0.01 : null;
    const totalVolumeUsd = totalVolumeSol != null && nativeSolPrice != null
      ? totalVolumeSol * nativeSolPrice
      : null;

    const dexTwitter = best.info?.socials?.find(
      (social) => social.type === "twitter",
    )?.url ?? null;
    const dexTelegram = best.info?.socials?.find(
      (social) => social.type === "telegram",
    )?.url ?? null;
    const dexWebsite = best.info?.websites?.[0]?.url ?? null;

    const responseData = {
      pair: {
        dexId: best.dexId,
        pairAddress: best.pairAddress,
        symbol: best.baseToken.symbol,
        name: best.baseToken.name,
        priceUsd: Number.isFinite(parsedPriceUsd) ? parsedPriceUsd : null,
        priceNative: Number.isFinite(parsedPriceNative) ? parsedPriceNative : null,
        fdv: best.fdv ?? null,
        marketCap: best.marketCap ?? null,
        volumeH24: best.volume?.h24 ?? null,
        volumeH6: best.volume?.h6 ?? null,
        volumeH1: best.volume?.h1 ?? null,
        volumeM5: best.volume?.m5 ?? null,
        change24h: best.priceChange?.h24 ?? null,
        changeH1: best.priceChange?.h1 ?? null,
        buysH1: best.txns?.h1?.buys ?? null,
        sellsH1: best.txns?.h1?.sells ?? null,
        buysH24: best.txns?.h24?.buys ?? null,
        sellsH24: best.txns?.h24?.sells ?? null,
        liquidityUsd: best.liquidity?.usd ?? null,
        liquidity: best.liquidity?.usd ?? null,
        createdAt: best.pairCreatedAt ?? null,
        createdAtSemantics: "selected_dex_pair_created_at",
        totalVolumeSol,
        totalFeesSol,
        totalVolumeUsd,
        totalVolumeCompleteness: "pumpfun-v2-first-300-trades-max",
        solPrice: nativeSolPrice,
        uniqueTraders: tradesData?.uniqueTraders ?? null,
        bcProgress: pumpInfo?.progress ?? null,
        bcMigrated: pumpInfo?.migrated ?? null,
        twitter: dexTwitter || pumpInfo?.twitter || null,
        telegram: dexTelegram || pumpInfo?.telegram || null,
        website: dexWebsite || pumpInfo?.website || null,
      },
      meta: {
        source: "dexscreener-most-liquid-solana-base-pair",
        stale: false,
        fetchedAt: Date.now(),
        servedAt: Date.now(),
      },
    };

    setBoundedCache(cache, mint, { data: responseData, timestamp: Date.now() }, MAX_CACHE_ENTRIES);
    return response(responseData);
  } catch {
    if (cached) {
      const value = cached.data as Record<string, unknown>;
      return response({
        ...value,
        meta: {
          ...((value.meta as Record<string, unknown> | undefined) || {}),
          stale: true,
          cache: "stale-fallback",
          servedAt: Date.now(),
        },
      });
    }
    return NextResponse.json({ error: "token_snapshot_unavailable" }, { status: 502 });
  }
}
