import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

// data-tag: api.token_history
// Historical OHLCV proxy. All returned OHLC values use per-token USD units.
// Real data is the default; deterministic mock data is available only via ?mock=true.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 30;

const BITQUERY_KEY = process.env.BITQUERY_API_KEY || "";
const BITQUERY_URL = "https://streaming.bitquery.io/eap";

const TF_SECONDS: Record<string, number> = {
  "1s": 1,
  "5s": 5,
  "15s": 15,
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};
const VALID_TIMEFRAMES = new Set(Object.keys(TF_SECONDS));

const TF_MAP: Record<string, { tf: "minute" | "hour" | "day"; agg: number }> = {
  "1s": { tf: "minute", agg: 1 },
  "5s": { tf: "minute", agg: 1 },
  "15s": { tf: "minute", agg: 1 },
  "1m": { tf: "minute", agg: 1 },
  "5m": { tf: "minute", agg: 5 },
  "15m": { tf: "minute", agg: 15 },
  "1h": { tf: "hour", agg: 1 },
  "4h": { tf: "hour", agg: 4 },
  "1d": { tf: "day", agg: 1 },
};

const BQ_INTERVAL: Record<string, { count: number; unit: "seconds" | "minutes" | "hours" | "days" }> = {
  "1s": { count: 1, unit: "seconds" },
  "5s": { count: 5, unit: "seconds" },
  "15s": { count: 15, unit: "seconds" },
  "1m": { count: 1, unit: "minutes" },
  "5m": { count: 5, unit: "minutes" },
  "15m": { count: 15, unit: "minutes" },
  "1h": { count: 1, unit: "hours" },
  "4h": { count: 4, unit: "hours" },
  "1d": { count: 1, unit: "days" },
};

const TF_TIME_WINDOWS: Record<string, number> = {
  "1s": 24 * 60 * 60 * 1000,
  "5s": 3 * 24 * 60 * 60 * 1000,
  "15s": 7 * 24 * 60 * 60 * 1000,
  "1m": 30 * 24 * 60 * 60 * 1000,
  "5m": 30 * 24 * 60 * 60 * 1000,
  "15m": 30 * 24 * 60 * 60 * 1000,
  "1h": 60 * 24 * 60 * 60 * 1000,
  "4h": 90 * 24 * 60 * 60 * 1000,
  "1d": 365 * 24 * 60 * 60 * 1000,
};

const BQ_LIMIT: Record<string, number> = {
  "1s": 43200,
  "5s": 17280,
  "15s": 11520,
  "1m": 5000,
  "5m": 5000,
  "15m": 3000,
  "1h": 2000,
  "4h": 1000,
  "1d": 500,
};

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const PUMP_INTERVAL: Record<string, string> = {
  "1s": "1s",
  "5s": "1s",
  "15s": "15s",
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
  "1d": "1h",
};

const PUMP_BUCKET: Record<string, number> = {
  "5s": 5,
  "1d": 86400,
};

function rebucket(candles: Candle[], bucketSec: number): Candle[] {
  const buckets = new Map<number, Candle>();
  for (const candle of candles) {
    const bucket = Math.floor(candle.time / bucketSec) * bucketSec;
    const existing = buckets.get(bucket);
    if (!existing) {
      buckets.set(bucket, { ...candle, time: bucket });
    } else {
      existing.high = Math.max(existing.high, candle.high);
      existing.low = Math.min(existing.low, candle.low);
      existing.close = candle.close;
      existing.volume += candle.volume;
    }
  }
  return Array.from(buckets.values()).sort((left, right) => left.time - right.time);
}

const pumpCache = new Map<string, { candles: Candle[]; timestamp: number }>();

const PUMP_CACHE_TTL: Record<string, number> = {
  "1s": 1_000,
  "5s": 1_000,
  "15s": 1_000,
  "1m": 10_000,
  "5m": 30_000,
  "15m": 60_000,
  "1h": 120_000,
  "4h": 300_000,
  "1d": 300_000,
};

/**
 * Fetch Pump.fun candle history. For second-level timeframes we keep only
 * native second-level rows; older minute candles are never relabelled as 1s/5s/15s.
 */
async function fetchFromPumpFun(mint: string, tf: string, deep = false): Promise<Candle[]> {
  const interval = PUMP_INTERVAL[tf] ?? "1m";
  const cacheKey = `${mint}:${tf}:${deep ? "deep" : "fast"}`;
  const ttl = PUMP_CACHE_TTL[tf] ?? 3_000;
  const cached = pumpCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < ttl) return cached.candles;

  try {
    type PumpRow = { timestamp: number; open: string; high: string; low: string; close: string; volume: string };
    const pageLimit = 1000;
    const encodedMint = encodeURIComponent(mint);
    const v1Url = `https://swap-api.pump.fun/v1/coins/${encodedMint}/candles?interval=${encodeURIComponent(interval)}&limit=${pageLimit}`;
    const first = await fetch(v1Url, { headers: { Accept: "application/json" }, cache: "no-store" });
    let allRows: PumpRow[] = [];
    if (first.ok) {
      const rows = (await first.json()) as PumpRow[];
      if (Array.isArray(rows)) allRows = rows;
    }

    const wantsHistory = interval === "1m" || interval === "5m" || interval === "15m"
      || interval === "1h" || interval === "4h";
    if (deep && wantsHistory && allRows.length > 0) {
      const maxHistoryPages = interval === "1m" ? 8 : interval === "5m" || interval === "15m" ? 12 : 20;
      let earliestTs = allRows[0].timestamp;
      for (const row of allRows) if (row.timestamp < earliestTs) earliestTs = row.timestamp;
      const existingTs = new Set(allRows.map((row) => row.timestamp));
      let previousEarliest = -1;
      for (let page = 0; page < maxHistoryPages; page += 1) {
        if (earliestTs === previousEarliest) break;
        previousEarliest = earliestTs;
        const v2Url = `https://swap-api.pump.fun/v2/coins/${encodedMint}/candles?interval=${encodeURIComponent(interval)}&limit=${pageLimit}&createdTs=${earliestTs}`;
        try {
          const response = await fetch(v2Url, { headers: { Accept: "application/json" }, cache: "no-store" });
          if (!response.ok) break;
          const rows = (await response.json()) as PumpRow[];
          if (!Array.isArray(rows) || rows.length === 0) break;
          const fresh = rows.filter((row) => !existingTs.has(row.timestamp));
          if (fresh.length === 0) break;
          for (const row of fresh) {
            existingTs.add(row.timestamp);
            if (row.timestamp < earliestTs) earliestTs = row.timestamp;
          }
          allRows.push(...fresh);
          if (rows.length < pageLimit) break;
        } catch {
          break;
        }
      }
    }

    const isSubMinute = tf === "1s" || tf === "5s" || tf === "15s";
    if (deep && isSubMinute && allRows.length > 0) {
      let earliestTs = allRows[0].timestamp;
      for (const row of allRows) if (row.timestamp < earliestTs) earliestTs = row.timestamp;
      const existingTs = new Set(allRows.map((row) => row.timestamp));
      let previousEarliest = -1;
      for (let page = 0; page < 4; page += 1) {
        if (earliestTs === previousEarliest) break;
        previousEarliest = earliestTs;
        const v2Url = `https://swap-api.pump.fun/v2/coins/${encodedMint}/candles?interval=${encodeURIComponent(interval)}&limit=${pageLimit}&createdTs=${earliestTs}`;
        try {
          const response = await fetch(v2Url, { headers: { Accept: "application/json" }, cache: "no-store" });
          if (!response.ok) break;
          const rows = (await response.json()) as PumpRow[];
          if (!Array.isArray(rows) || rows.length === 0) break;
          const fresh = rows.filter((row) => !existingTs.has(row.timestamp));
          if (fresh.length === 0) break;
          for (const row of fresh) {
            existingTs.add(row.timestamp);
            if (row.timestamp < earliestTs) earliestTs = row.timestamp;
          }
          allRows.push(...fresh);
        } catch {
          break;
        }
      }
    }

    if (allRows.length === 0) return cached?.candles ?? [];

    const raw = allRows
      .map((row) => {
        let open = Number(row.open) || 0;
        let high = Number(row.high) || 0;
        let low = Number(row.low) || 0;
        let close = Number(row.close) || 0;

        // Pump.fun candle endpoints may expose bonding-curve values in market-cap
        // units. Normalize that source here so every downstream consumer receives
        // per-token USD. Do not repeat this magnitude heuristic in the client.
        if (close > 1) {
          open /= 1_000_000_000;
          high /= 1_000_000_000;
          low /= 1_000_000_000;
          close /= 1_000_000_000;
        }

        return {
          time: Math.floor(row.timestamp / 1000),
          open,
          high,
          low,
          close,
          volume: Number(row.volume) || 0,
        };
      })
      .filter((candle) => candle.open > 0 && candle.close > 0)
      .sort((left, right) => left.time - right.time);

    const seen = new Set<number>();
    const deduped = raw.filter((candle) => {
      if (seen.has(candle.time)) return false;
      seen.add(candle.time);
      return true;
    });
    const bucketSec = PUMP_BUCKET[tf];
    const candles = bucketSec ? rebucket(deduped, bucketSec) : deduped;
    pumpCache.set(cacheKey, { candles, timestamp: Date.now() });
    return candles;
  } catch {
    return [];
  }
}

async function fetchSubMinuteCandles(mint: string, bucketSec: number, timeframe: string): Promise<Candle[]> {
  if (!BITQUERY_KEY) return [];
  const windowMs = TF_TIME_WINDOWS[timeframe] || 30 * 60 * 1000;
  const since = new Date(Date.now() - windowMs).toISOString();

  const query = `
    query RawTrades($mint: String!) {
      Solana {
        DEXTradeByTokens(
          where: {
            Trade: { Currency: { MintAddress: { is: $mint } } }
            Block: { Time: { since: "${since}" } }
          }
          orderBy: { ascendingByField: "Block_Time" }
          limit: { count: 1000 }
        ) {
          Block { Time }
          Trade {
            PriceInUSD
            Side { AmountInUSD }
          }
        }
      }
    }
  `;

  try {
    const response = await fetch(BITQUERY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": BITQUERY_KEY },
      body: JSON.stringify({ query, variables: { mint } }),
      cache: "no-store",
    });
    if (!response.ok) return [];
    const data = await response.json();
    if (data.errors) return [];

    type RawTrade = {
      Block: { Time: string };
      Trade: { PriceInUSD: number; Side: { AmountInUSD: string | number } };
    };
    const trades: RawTrade[] = data.data?.Solana?.DEXTradeByTokens ?? [];
    const buckets = new Map<number, Candle>();
    for (const trade of trades) {
      const ts = Math.floor(new Date(trade.Block.Time).getTime() / 1000);
      const bucket = Math.floor(ts / bucketSec) * bucketSec;
      const price = Number(trade.Trade?.PriceInUSD) || 0;
      const volume = Number(trade.Trade?.Side?.AmountInUSD) || 0;
      if (!Number.isFinite(ts) || price <= 0) continue;
      const existing = buckets.get(bucket);
      if (!existing) {
        buckets.set(bucket, { time: bucket, open: price, high: price, low: price, close: price, volume });
      } else {
        existing.high = Math.max(existing.high, price);
        existing.low = Math.min(existing.low, price);
        existing.close = price;
        existing.volume += volume;
      }
    }
    return Array.from(buckets.values()).sort((left, right) => left.time - right.time);
  } catch {
    return [];
  }
}

async function fetchFromBitquery(mint: string, tf: string): Promise<Candle[]> {
  if (!BITQUERY_KEY) return [];
  const interval = BQ_INTERVAL[tf] ?? BQ_INTERVAL["1m"];
  const lookback = TF_TIME_WINDOWS[tf] ?? 30 * 24 * 3600 * 1000;
  const since = new Date(Date.now() - lookback).toISOString();
  const limit = BQ_LIMIT[tf] ?? 1000;

  const query = `
    query Ohlcv($mint: String!) {
      Solana {
        DEXTradeByTokens(
          where: {
            Trade: { Currency: { MintAddress: { is: $mint } } }
            Block: { Time: { since: "${since}" } }
          }
          orderBy: { ascendingByField: "Block_Time" }
          limit: { count: ${limit} }
        ) {
          Block {
            Time(interval: { in: ${interval.unit}, count: ${interval.count} })
          }
          Trade {
            high: PriceInUSD(maximum: Trade_PriceInUSD)
            low: PriceInUSD(minimum: Trade_PriceInUSD)
            open: PriceInUSD(minimum: Block_Slot)
            close: PriceInUSD(maximum: Block_Slot)
          }
          volume: sum(of: Trade_Side_AmountInUSD)
        }
      }
    }
  `;

  try {
    const response = await fetch(BITQUERY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": BITQUERY_KEY },
      body: JSON.stringify({ query, variables: { mint } }),
      cache: "no-store",
    });
    if (!response.ok) return [];
    const data = await response.json();
    if (data.errors) return [];

    type Row = {
      Block: { Time: string };
      Trade: { open: number; close: number; high: number; low: number };
      volume: string | number;
    };
    const rows: Row[] = data.data?.Solana?.DEXTradeByTokens ?? [];
    const byBucket = new Map<number, Candle>();
    for (const row of rows) {
      const time = Math.floor(new Date(row.Block.Time).getTime() / 1000);
      const open = Number(row.Trade?.open) || 0;
      const close = Number(row.Trade?.close) || 0;
      const high = Number(row.Trade?.high) || 0;
      const low = Number(row.Trade?.low) || 0;
      const volume = Number(row.volume) || 0;
      if (!Number.isFinite(time) || open <= 0 || close <= 0) continue;
      const existing = byBucket.get(time);
      if (!existing) {
        byBucket.set(time, { time, open, high, low, close, volume });
      } else {
        existing.high = Math.max(existing.high, high);
        existing.low = Math.min(existing.low, low);
        existing.close = close;
        existing.volume += volume;
      }
    }
    return Array.from(byBucket.values()).sort((left, right) => left.time - right.time);
  } catch {
    return [];
  }
}

type GTCandle = [number, number, number, number, number, number];
type GTResponse = {
  data?: {
    attributes?: {
      ohlcv_list?: GTCandle[];
    };
  };
};

async function findPool(mint: string): Promise<string | null> {
  const response = await fetch(
    `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${encodeURIComponent(mint)}/pools?page=1`,
    { headers: { Accept: "application/json" }, cache: "no-store" },
  );
  if (!response.ok) return null;
  const data = await response.json();
  const pools = (data?.data ?? []) as Array<{
    attributes?: {
      address?: string;
      reserve_in_usd?: string;
      volume_usd?: { h24?: string };
    };
  }>;
  if (pools.length === 0) return null;
  const sorted = pools
    .filter((pool) => pool.attributes?.address)
    .sort((left, right) => {
      const leftLiquidity = parseFloat(left.attributes?.reserve_in_usd ?? "0") || 0;
      const rightLiquidity = parseFloat(right.attributes?.reserve_in_usd ?? "0") || 0;
      if (rightLiquidity !== leftLiquidity) return rightLiquidity - leftLiquidity;
      const leftVolume = parseFloat(left.attributes?.volume_usd?.h24 ?? "0") || 0;
      const rightVolume = parseFloat(right.attributes?.volume_usd?.h24 ?? "0") || 0;
      return rightVolume - leftVolume;
    });
  return sorted[0]?.attributes?.address ?? null;
}

function generateMockCandles(mint: string, timeframe: string, count: number): Candle[] {
  const candles: Candle[] = [];
  const tfSec = TF_SECONDS[timeframe] ?? 60;
  // Align deterministic mock timestamps to the same candle bucket boundaries
  // that real OHLC sources use (e.g. 5s candles always start on :00/:05/:10...).
  const now = Math.floor(Date.now() / 1000 / tfSec) * tfSec;

  let seed = mint.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const random = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };

  let price = 0.0001 + random() * 0.001;
  for (let index = count; index >= 0; index -= 1) {
    const time = now - index * tfSec;
    const trend = (random() - 0.45) * 0.08;
    const volatility = random() * 0.02;
    const open = price;
    const close = price * (1 + trend);
    const high = Math.max(open, close) * (1 + volatility);
    const low = Math.min(open, close) * (1 - volatility);
    const volume = 100 + random() * 900;
    candles.push({ time, open, high, low, close, volume });
    price = close;
  }
  return candles;
}

function jsonCandles(candles: Candle[], source: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json(
    { candles, source, priceUnit: "token_usd", ...extra },
    { headers: { "Cache-Control": "public, max-age=30" } },
  );
}

export async function GET(req: NextRequest) {
  const mint = req.nextUrl.searchParams.get("mint")?.trim() || "";
  const timeframe = req.nextUrl.searchParams.get("tf") ?? "1m";
  const forceMock = req.nextUrl.searchParams.get("mock") === "true";
  const deep = req.nextUrl.searchParams.get("deep") === "1";

  if (!mint) return NextResponse.json({ error: "mint required" }, { status: 400 });
  try {
    if (new PublicKey(mint).toBase58() !== mint) throw new Error("non-canonical mint");
  } catch {
    return NextResponse.json({ error: "invalid Solana mint" }, { status: 400 });
  }
  if (!VALID_TIMEFRAMES.has(timeframe)) {
    return NextResponse.json({ error: "invalid timeframe", allowed: [...VALID_TIMEFRAMES] }, { status: 400 });
  }

  if (forceMock) {
    const windowMs = TF_TIME_WINDOWS[timeframe] || 86_400_000;
    const mockCount = Math.min(300, Math.max(20, Math.floor(windowMs / 1000 / TF_SECONDS[timeframe])));
    return jsonCandles(generateMockCandles(mint, timeframe, mockCount), "mock", { mock: true });
  }

  const cfg = TF_MAP[timeframe];
  const isSubMinute = timeframe === "1s" || timeframe === "5s" || timeframe === "15s";

  if (isSubMinute) {
    try {
      const pumpCandles = await fetchFromPumpFun(mint, timeframe, deep);
      if (pumpCandles.length > 0) return jsonCandles(pumpCandles, "pumpfun");
    } catch {
      // fall through to Bitquery raw trades
    }

    const bucketSec = TF_SECONDS[timeframe];
    const candles = await fetchSubMinuteCandles(mint, bucketSec, timeframe);
    return jsonCandles(candles, "bitquery_raw", candles.length === 0 ? { error: "no_data" } : {});
  }

  try {
    const pumpCandles = await fetchFromPumpFun(mint, timeframe, deep);
    if (pumpCandles.length > 0) {
      const serverTtlSec = Math.floor((PUMP_CACHE_TTL[timeframe] ?? 10_000) / 1000);
      const cacheHeader = serverTtlSec < 1
        ? "no-store"
        : `public, max-age=${serverTtlSec}, stale-while-revalidate=${serverTtlSec * 2}`;
      return NextResponse.json(
        { candles: pumpCandles, source: "pumpfun", priceUnit: "token_usd" },
        { headers: { "Cache-Control": cacheHeader } },
      );
    }
  } catch {
    // fall through to Bitquery
  }

  try {
    const bitqueryCandles = await fetchFromBitquery(mint, timeframe);
    if (bitqueryCandles.length > 0) return jsonCandles(bitqueryCandles, "bitquery");
  } catch {
    // fall through to GeckoTerminal
  }

  try {
    const poolAddress = await findPool(mint);
    if (poolAddress) {
      const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${encodeURIComponent(poolAddress)}`
        + `/ohlcv/${cfg.tf}?aggregate=${cfg.agg}&limit=1000&currency=usd`;
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (response.ok) {
        const data = (await response.json()) as GTResponse;
        const raw = data?.data?.attributes?.ohlcv_list ?? [];
        const candles = raw
          .map(([ts, open, high, low, close, volume]) => ({ time: ts, open, high, low, close, volume }))
          .filter((candle) => candle.open > 0 && candle.close > 0)
          .sort((left, right) => left.time - right.time);
        if (candles.length > 0) {
          return NextResponse.json(
            { poolAddress, candles, source: "geckoterminal", priceUnit: "token_usd" },
            { headers: { "Cache-Control": "public, max-age=30" } },
          );
        }
      }
    }
  } catch {
    // no real source available
  }

  return NextResponse.json(
    { candles: [], source: "none", priceUnit: "token_usd", error: "no_data" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
