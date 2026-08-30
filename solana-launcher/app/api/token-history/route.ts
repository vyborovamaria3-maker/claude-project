import { NextRequest, NextResponse } from "next/server";

// data-tag: api.token_history
// Historical OHLCV proxy → GeckoTerminal Onchain API (free, no auth).
// Returns full candle history from token creation.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 30; // Cache for 30 seconds at edge

const BITQUERY_KEY = process.env.BITQUERY_API_KEY || "";
const BITQUERY_URL = "https://streaming.bitquery.io/eap";
const IS_DEV = process.env.NODE_ENV === "development";

// Map our Timeframe → GeckoTerminal `timeframe` + `aggregate`
const TF_MAP: Record<string, { tf: "minute" | "hour" | "day"; agg: number }> = {
  "1s":  { tf: "minute", agg: 1 },   // GT min granularity is minute; will look flat for 1s
  "5s":  { tf: "minute", agg: 1 },
  "15s": { tf: "minute", agg: 1 },
  "1m":  { tf: "minute", agg: 1 },
  "5m":  { tf: "minute", agg: 5 },
  "15m": { tf: "minute", agg: 15 },
  "1h":  { tf: "hour",   agg: 1 },
  "4h":  { tf: "hour",   agg: 4 },
  "1d":  { tf: "day",    agg: 1 },
};

// Bitquery interval per timeframe
const BQ_INTERVAL: Record<string, { count: number; unit: "seconds" | "minutes" | "hours" | "days" }> = {
  "1s":  { count: 1, unit: "seconds" },
  "5s":  { count: 5, unit: "seconds" },
  "15s": { count: 15, unit: "seconds" },
  "1m":  { count: 1, unit: "minutes" },
  "5m":  { count: 5, unit: "minutes" },
  "15m": { count: 15, unit: "minutes" },
  "1h":  { count: 1, unit: "hours" },
  "4h":  { count: 4, unit: "hours" },
  "1d":  { count: 1, unit: "days" },
};

// Time window per timeframe — wide enough to capture Pump.fun bonding curve from token creation.
// Most Pump.fun tokens graduate or die within days; 30-day window covers full lifecycle.
const TF_TIME_WINDOWS: Record<string, number> = {
  "1s":  24 * 60 * 60 * 1000,   // 24h via synthetic-from-1m
  "5s":  3 * 24 * 60 * 60 * 1000,  // 3 days
  "15s": 7 * 24 * 60 * 60 * 1000,  // 7 days
  "1m":  30 * 24 * 60 * 60 * 1000,  // 30 days — capture bonding curve from creation
  "5m":  30 * 24 * 60 * 60 * 1000,  // 30 days
  "15m": 30 * 24 * 60 * 60 * 1000,  // 30 days
  "1h":  60 * 24 * 60 * 60 * 1000,  // 60 days
  "4h":  90 * 24 * 60 * 60 * 1000,  // 90 days
  "1d":  365 * 24 * 60 * 60 * 1000, // 1 year
};

// Per-timeframe row limits for Bitquery (each row = 1 aggregated candle bucket)
const BQ_LIMIT: Record<string, number> = {
  "1s": 43200,  // 12h @ 1s
  "5s": 17280,  // 24h @ 5s
  "15s": 11520, // 48h @ 15s
  "1m": 5000,   // 30 days @ 1m (sparse buckets)
  "5m": 5000,
  "15m": 3000,
  "1h": 2000,
  "4h": 1000,
  "1d": 500,
};

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number; }

// Map our timeframe → Pump.fun swap-api interval format.
// Pump.fun supports: 1s, 15s, 30s, 1m, 5m, 15m, 30m, 1h, 4h
// For unsupported tfs (5s, 1d), we fetch a smaller native one and bucket server-side.
const PUMP_INTERVAL: Record<string, string> = {
  "1s":  "1s",
  "5s":  "1s",   // not native — fetch 1s and bucket into 5s
  "15s": "15s",
  "1m":  "1m",
  "5m":  "5m",
  "15m": "15m",
  "1h":  "1h",
  "4h":  "4h",
  "1d":  "1h",   // not native — fetch 1h and bucket into 1d
};

// Bucket size in seconds when we need server-side re-aggregation
const PUMP_BUCKET: Record<string, number> = {
  "5s": 5,
  "1d": 86400,
};

function rebucket(candles: Candle[], bucketSec: number): Candle[] {
  const buckets = new Map<number, Candle>();
  for (const c of candles) {
    const bucket = Math.floor(c.time / bucketSec) * bucketSec;
    const existing = buckets.get(bucket);
    if (!existing) {
      buckets.set(bucket, { ...c, time: bucket });
    } else {
      existing.high = Math.max(existing.high, c.high);
      existing.low = Math.min(existing.low, c.low);
      existing.close = c.close;
      existing.volume += c.volume;
    }
  }
  const result = Array.from(buckets.values()).sort((a, b) => a.time - b.time);
  return result;
}

// In-memory server-side cache for Pump.fun candles (per process, resets on dev reload)
// Key: `${mint}:${tf}` -> { candles, timestamp }
const pumpCache = new Map<string, { candles: Candle[]; timestamp: number }>();
// Raw pump.fun rows cache (used for deep 1m history reused across sub-second requests)
type PumpRowCached = { timestamp: number; open: string; high: string; low: string; close: string; volume: string };
const pumpRawCache = new Map<string, { rows: PumpRowCached[]; timestamp: number }>();

// Cache TTLs:
//   sub-minute: 1s — near-realtime with better cache hit rate
//   1m/5m/15m:  10s/30s/60s — reduced requests, stale-while-revalidate handles freshness
//   1h+:        120s/300s — history rarely changes, expensive multi-page fetch
const PUMP_CACHE_TTL: Record<string, number> = {
  "1s":  1_000,
  "5s":  1_000,
  "15s": 1_000,
  "1m":  10_000,
  "5m":  30_000,
  "15m": 60_000,
  "1h":  120_000,
  "4h":  300_000,
  "1d":  300_000,
};

/**
 * Fetch full OHLCV history from Pump.fun swap-api.
 * Includes BONDING CURVE trades from token creation — the authoritative source for Pump.fun tokens.
 * Endpoint: https://swap-api.pump.fun/v1/coins/{mint}/candles?interval={tf}&limit={n}
 */
async function fetchFromPumpFun(mint: string, tf: string, deep = false): Promise<Candle[]> {
  const interval = PUMP_INTERVAL[tf] ?? "1m";
  const cacheKey = `${mint}:${tf}:${deep ? "deep" : "fast"}`;
  const ttl = PUMP_CACHE_TTL[tf] ?? 3_000;

  const cached = pumpCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < ttl) {
    return cached.candles;
  }

  try {
    type PumpRow = { timestamp: number; open: string; high: string; low: string; close: string; volume: string };
    const pageLimit = 1000;
    let allRows: PumpRow[] = [];
    const isSubMinTfEarly = tf === "1s" || tf === "5s" || tf === "15s";

    // Step 1: v1 fetch (returns up to pageLimit recent candles).
    // For sub-second TFs, kick off 1m fetch in parallel — we'll need it anyway for synthetic backfill.
    const v1Url = `https://swap-api.pump.fun/v1/coins/${mint}/candles?interval=${interval}&limit=${pageLimit}`;
    const v1mUrl = `https://swap-api.pump.fun/v1/coins/${mint}/candles?interval=1m&limit=${pageLimit}`;
    const [r1, r1mPre] = await Promise.all([
      fetch(v1Url, { headers: { Accept: "application/json" }, cache: "no-store" }),
      isSubMinTfEarly ? fetch(v1mUrl, { headers: { Accept: "application/json" }, cache: "no-store" }) : Promise.resolve(null as Response | null),
    ]);
    if (r1.ok) {
      const rows = (await r1.json()) as PumpRow[];
      if (Array.isArray(rows)) allRows = rows;
    }
    let rows1mPreloaded: PumpRow[] | null = null;
    if (r1mPre && r1mPre.ok) {
      const rows = (await r1mPre.json()) as PumpRow[];
      if (Array.isArray(rows)) rows1mPreloaded = rows;
    }

    // Step 2: for 1m+ timeframes, expand history via v2 endpoint with createdTs pointing
    // to (or just past) the earliest v1 candle — this triggers extended-history mode.
    // Paginate backwards multiple times to cover token's full lifetime.
    const wantsHistory = interval === "1m" || interval === "5m" || interval === "15m" ||
                         interval === "1h" || interval === "4h";
    if (deep && wantsHistory && allRows.length > 0) {
      const maxHistoryPages = interval === "1m" ? 8 :
                              interval === "5m" || interval === "15m" ? 12 : 20;
      // Track earliest incrementally — avoids O(n²) Math.min on growing array.
      let earliestTs = allRows[0].timestamp;
      for (const r of allRows) if (r.timestamp < earliestTs) earliestTs = r.timestamp;
      let prevEarliest = -1;
      for (let page = 0; page < maxHistoryPages; page++) {
        if (earliestTs === prevEarliest) break;
        prevEarliest = earliestTs;
        const v2Url = `https://swap-api.pump.fun/v2/coins/${mint}/candles?interval=${interval}&limit=${pageLimit}&createdTs=${earliestTs}`;
        try {
          const rPage = await fetch(v2Url, { headers: { Accept: "application/json" }, cache: "no-store" });
          if (!rPage.ok) break;
          const rowsPage = (await rPage.json()) as PumpRow[];
          if (!Array.isArray(rowsPage) || rowsPage.length === 0) break;
          for (const r of rowsPage) if (r.timestamp < earliestTs) earliestTs = r.timestamp;
          allRows.push(...rowsPage);
          if (rowsPage.length < pageLimit) break;
        } catch { break; }
      }
    }

    // Step 3: for sub-minute tfs (1s/15s), paginate backwards via v2 createdTs — same strategy as 1m.
    // Each pass fetches up to pageLimit candles ending just before the earliest known candle.
    const isSubMinTf = tf === "1s" || tf === "5s" || tf === "15s";
    const targetWindowSec = (TF_TIME_WINDOWS[tf] ?? 2 * 3600 * 1000) / 1000;
    // Pump.fun v2 createdTs doesn't actually page back for sub-second TFs (returns duplicates).
    // Loop breaks on first no-progress — keep low cap to avoid wasted retries.
    const maxPages = 4;
    if (deep && isSubMinTf && allRows.length > 0) {
      // Track earliest timestamp incrementally — avoids O(n²) Math.min scans on growing array.
      let earliestTs = allRows[0].timestamp;
      for (const r of allRows) if (r.timestamp < earliestTs) earliestTs = r.timestamp;
      const existingTs = new Set(allRows.map(r => r.timestamp));
      const nowSec = Math.floor(Date.now() / 1000);
      let prevEarliest = -1;
      for (let page = 0; page < maxPages; page++) {
        if (earliestTs === prevEarliest) break;
        prevEarliest = earliestTs;
        if (nowSec - Math.floor(earliestTs / 1000) >= targetWindowSec) break;
        const v2Url = `https://swap-api.pump.fun/v2/coins/${mint}/candles?interval=${interval}&limit=${pageLimit}&createdTs=${earliestTs}`;
        try {
          const rPage = await fetch(v2Url, { headers: { Accept: "application/json" }, cache: "no-store" });
          if (!rPage.ok) break;
          const rowsPage = (await rPage.json()) as PumpRow[];
          if (!Array.isArray(rowsPage) || rowsPage.length === 0) break;
          const fresh = rowsPage.filter(r => !existingTs.has(r.timestamp));
          if (fresh.length === 0) break;
          for (const r of fresh) {
            existingTs.add(r.timestamp);
            if (r.timestamp < earliestTs) earliestTs = r.timestamp;
          }
          allRows.push(...fresh);
        } catch { break; }
      }
    }

    // Step 4: for sub-second TFs, fill older history (where pump.fun has no 1s data)
    // by expanding 1m candles into 60 synthetic 1s candles each with linear interpolation.
    // This makes the entire chart appear as a continuous second-level timeframe.
    if (deep && isSubMinTf && allRows.length > 0) {
      let earliestSubSecMs = allRows[0].timestamp;
      for (const r of allRows) if (r.timestamp < earliestSubSecMs) earliestSubSecMs = r.timestamp;
      const targetStartMs = Date.now() - targetWindowSec * 1000;
      if (earliestSubSecMs > targetStartMs + 60_000) {
        try {
          // Reuse the 1m fetch we kicked off in parallel during Step 1, plus any cached deep history.
          const oneMinKey = `${mint}:1m-deep`;
          const cached1m = pumpRawCache.get(oneMinKey);
          // Long-TTL cache: 5 min — minute candles don't change after they close.
          let rows1m: PumpRow[] = (cached1m && Date.now() - cached1m.timestamp < 300_000)
            ? cached1m.rows
            : (rows1mPreloaded ?? []);
          let earliest1m = rows1m.length ? rows1m[0].timestamp : Date.now();
          for (const r of rows1m) if (r.timestamp < earliest1m) earliest1m = r.timestamp;
          const existing1m = new Set(rows1m.map(r => r.timestamp));
          let prev1mEarliest = -1;
          for (let p = 0; p < 12 && rows1m.length > 0; p++) {
            if (earliest1m === prev1mEarliest) break;
            prev1mEarliest = earliest1m;
            if (earliest1m <= targetStartMs) break;
            try {
              const rP = await fetch(
                `https://swap-api.pump.fun/v2/coins/${mint}/candles?interval=1m&limit=1000&createdTs=${earliest1m}`,
                { headers: { Accept: "application/json" }, cache: "no-store" }
              );
              if (!rP.ok) break;
              const more = (await rP.json()) as PumpRow[];
              if (!Array.isArray(more) || more.length === 0) break;
              const fresh = more.filter(r => !existing1m.has(r.timestamp));
              if (fresh.length === 0) break;
              for (const r of fresh) {
                existing1m.add(r.timestamp);
                if (r.timestamp < earliest1m) earliest1m = r.timestamp;
              }
              rows1m.push(...fresh);
            } catch { break; }
          }
          // Persist deep 1m rows for fast reuse by later sub-second requests
          if (rows1m.length > 0) {
            pumpRawCache.set(`${mint}:1m-deep`, { rows: rows1m, timestamp: Date.now() });
          }
          if (rows1m.length > 0) {
            // Keep older 1m candles at their original minute timestamps — they render
            // as real candles in the chart (one per minute in the historical region).
            const olderMinutes = rows1m.filter(r => r.timestamp < earliestSubSecMs);
            allRows = [...allRows, ...olderMinutes];
          }
        } catch { /* ignore */ }
      }
    }

    if (allRows.length === 0) return cached?.candles ?? [];
    
    const raw = allRows
      .map(row => {
        // Pump.fun sometimes returns prices already multiplied by 1B (Market Cap units)
        // Detect this and convert back to actual price
        let open = Number(row.open) || 0;
        let high = Number(row.high) || 0;
        let low = Number(row.low) || 0;
        let close = Number(row.close) || 0;
        
        // If close > 1, it's likely in Market Cap units (price × 1B), so divide by 1B
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
      .filter(c => c.open > 0 && c.close > 0)
      .sort((a, b) => a.time - b.time);
    // Deduplicate by timestamp
    const seen = new Set<number>();
    const deduped = raw.filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; });
    // Re-bucket if the requested tf isn't natively supported (5s, 1d)
    const bucketSec = PUMP_BUCKET[tf];
    const candles = bucketSec ? rebucket(deduped, bucketSec) : deduped;
    pumpCache.set(cacheKey, { candles, timestamp: Date.now() });
    return candles;
  } catch {
    return [];
  }
}

/**
 * Fetch raw trades from Bitquery and aggregate into OHLCV candles at bucket size in seconds.
 * Used for real sub-minute history.
 */
async function fetchSubMinuteCandles(mint: string, bucketSec: number, timeframe: string): Promise<Candle[]> {
  if (!BITQUERY_KEY) return [];
  // Use optimized time window based on timeframe
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
    const r = await fetch(BITQUERY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": BITQUERY_KEY },
      body: JSON.stringify({ query, variables: { mint } }),
      cache: "no-store",
    });
    if (!r.ok) return [];
    const data = await r.json();
    if (data.errors) return [];

    type RawTrade = {
      Block: { Time: string };
      Trade: { PriceInUSD: number; Side: { AmountInUSD: string | number } };
    };
    const trades: RawTrade[] = data.data?.Solana?.DEXTradeByTokens ?? [];

    // Bucket by floor(timestamp / bucketSec) * bucketSec
    const buckets = new Map<number, Candle>();
    for (const t of trades) {
      const ts = Math.floor(new Date(t.Block.Time).getTime() / 1000);
      const bucket = Math.floor(ts / bucketSec) * bucketSec;
      const price = Number(t.Trade?.PriceInUSD) || 0;
      const vol = Number(t.Trade?.Side?.AmountInUSD) || 0;
      if (price <= 0) continue;

      const existing = buckets.get(bucket);
      if (!existing) {
        buckets.set(bucket, { time: bucket, open: price, high: price, low: price, close: price, volume: vol });
      } else {
        existing.high = Math.max(existing.high, price);
        existing.low = Math.min(existing.low, price);
        existing.close = price; // trades are ascending → last seen is the close
        existing.volume += vol;
      }
    }
    return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
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
    const r = await fetch(BITQUERY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": BITQUERY_KEY },
      body: JSON.stringify({ query, variables: { mint } }),
      cache: "no-store",
    });
    if (!r.ok) return [];
    const data = await r.json();
    if (data.errors) return [];

    type Row = {
      Block: { Time: string };
      Trade: { open: number; close: number; high: number; low: number };
      volume: string | number;
    };
    const rows: Row[] = data.data?.Solana?.DEXTradeByTokens ?? [];
    // Aggregate by bucket (Bitquery may return multiple rows per interval)
    const byBucket = new Map<number, Candle>();
    for (const row of rows) {
      const time = Math.floor(new Date(row.Block.Time).getTime() / 1000);
      const open = Number(row.Trade?.open) || 0;
      const close = Number(row.Trade?.close) || 0;
      const high = Number(row.Trade?.high) || 0;
      const low = Number(row.Trade?.low) || 0;
      const volume = Number(row.volume) || 0;
      if (open <= 0 || close <= 0) continue;
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
    return Array.from(byBucket.values()).sort((a, b) => a.time - b.time);
  } catch {
    return [];
  }
}

type GTCandle = [number, number, number, number, number, number]; // [ts, o, h, l, c, vol]
type GTResponse = {
  data?: {
    attributes?: {
      ohlcv_list?: GTCandle[];
    };
  };
};

async function findPool(mint: string): Promise<string | null> {
  // GeckoTerminal: GET pools for token, pick the MOST LIQUID one (matches DexScreener)
  const r = await fetch(
    `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools?page=1`,
    { headers: { Accept: "application/json" }, cache: "no-store" }
  );
  if (!r.ok) return null;
  const data = await r.json();
  const pools = (data?.data ?? []) as Array<{
    attributes?: {
      address?: string;
      reserve_in_usd?: string;
      volume_usd?: { h24?: string };
    };
  }>;
  if (pools.length === 0) return null;
  // Sort by reserve (liquidity) desc, fallback to 24h volume
  const sorted = pools
    .filter(p => p.attributes?.address)
    .sort((a, b) => {
      const la = parseFloat(a.attributes?.reserve_in_usd ?? "0") || 0;
      const lb = parseFloat(b.attributes?.reserve_in_usd ?? "0") || 0;
      if (lb !== la) return lb - la;
      const va = parseFloat(a.attributes?.volume_usd?.h24 ?? "0") || 0;
      const vb = parseFloat(b.attributes?.volume_usd?.h24 ?? "0") || 0;
      return vb - va;
    });
  return sorted[0]?.attributes?.address ?? null;
}

function generateMockCandles(mint: string, timeframe: string, count: number): Candle[] {
  const candles: Candle[] = [];
  const now = Math.floor(Date.now() / 1000);
  // Calculate seconds per candle based on TF_MAP unit (minute/hour/day)
  const cfg = TF_MAP[timeframe];
  let tfSec = 60; // default 1 minute
  if (cfg) {
    if (cfg.tf === "minute") tfSec = cfg.agg * 60;
    else if (cfg.tf === "hour") tfSec = cfg.agg * 3600;
    else if (cfg.tf === "day") tfSec = cfg.agg * 86400;
  }
  
  // Deterministic seed from mint
  let seed = mint.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const random = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  
  let price = 0.0001 + random() * 0.001;
  
  for (let i = count; i >= 0; i--) {
    const time = now - i * tfSec;
    const trend = (random() - 0.45) * 0.08; // Slight upward bias
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

export async function GET(req: NextRequest) {
  const mint = req.nextUrl.searchParams.get("mint");
  const timeframe = req.nextUrl.searchParams.get("tf") ?? "1m";
  const forceMock = req.nextUrl.searchParams.get("mock") === "true";
  const deep = req.nextUrl.searchParams.get("deep") === "1";
  
  if (!mint) {
    return NextResponse.json({ error: "mint required" }, { status: 400 });
  }
  
  // Only use mock if explicitly requested via ?mock=true
  if (forceMock) {
    const mockCount = Math.floor((TF_TIME_WINDOWS[timeframe] || 86400000) / ((TF_MAP[timeframe]?.agg || 1) * 60000));
    const mockCandles = generateMockCandles(mint, timeframe, Math.min(mockCount, 300));
    return NextResponse.json({ 
      candles: mockCandles, 
      source: "mock",
      mock: true 
    }, {
      headers: { "Cache-Control": "public, max-age=30" }
    });
  }

  const cfg = TF_MAP[timeframe] ?? TF_MAP["1m"];
  const isSubMinute = timeframe === "1s" || timeframe === "5s" || timeframe === "15s";

  // For sub-minute tfs: try Pump.fun first (has 1s/5s/15s native), then Bitquery raw trades
  if (isSubMinute) {
    try {
      const pumpCandles = await fetchFromPumpFun(mint, timeframe, deep);
      if (pumpCandles.length > 0) {
        return NextResponse.json({ candles: pumpCandles, source: "pumpfun" }, {
          headers: { "Cache-Control": "public, max-age=30" }
        });
      }
    } catch { /* fall through */ }
    
    const bucketSec = timeframe === "1s" ? 1 : timeframe === "5s" ? 5 : 15;
    const candles = await fetchSubMinuteCandles(mint, bucketSec, timeframe);
    
    // Fallback to mock in dev if no data
    if (candles.length === 0 && IS_DEV) {
      const mockCandles = generateMockCandles(mint, timeframe, 200);
      return NextResponse.json({ 
        candles: mockCandles, 
        source: "mock",
        mock: true 
      }, {
        headers: { "Cache-Control": "public, max-age=30" }
      });
    }
    
    return NextResponse.json({
      candles,
      source: "bitquery_raw",
      ...(candles.length === 0 ? { error: "no_data" } : {}),
    }, {
      headers: { "Cache-Control": "public, max-age=30" }
    });
  }

  // Try Pump.fun swap-api FIRST — authoritative source for Pump.fun tokens,
  // returns full history from token creation including bonding curve trades.
  try {
    const pumpCandles = await fetchFromPumpFun(mint, timeframe, deep);
    if (pumpCandles.length > 0) {
      const serverTtlSec = Math.floor((PUMP_CACHE_TTL[timeframe] ?? 10_000) / 1000);
      const cacheHeader = serverTtlSec < 1
        ? "no-store"
        : `public, max-age=${serverTtlSec}, stale-while-revalidate=${serverTtlSec * 2}`;
      return NextResponse.json({ candles: pumpCandles, source: "pumpfun" }, {
        headers: { "Cache-Control": cacheHeader }
      });
    }
  } catch {
    // fall through to Bitquery
  }

  // Try Bitquery — also indexes bonding curve trades (if API key has credits)
  try {
    const bqCandles = await fetchFromBitquery(mint, timeframe);
    if (bqCandles.length > 0) {
      return NextResponse.json({ candles: bqCandles, source: "bitquery" }, {
        headers: { "Cache-Control": "public, max-age=30" }
      });
    }
  } catch {
    // fall through to GeckoTerminal
  }

  // Fallback: GeckoTerminal (only has post-graduation DEX pool data)
  try {
    const poolAddress = await findPool(mint);
    if (poolAddress) {
      const url =
        `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}` +
        `/ohlcv/${cfg.tf}?aggregate=${cfg.agg}&limit=1000&currency=usd`;
      const r = await fetch(url, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (r.ok) {
        const data = (await r.json()) as GTResponse;
        const raw = data?.data?.attributes?.ohlcv_list ?? [];
        const candles = raw
          .map(([ts, o, h, l, c, vol]) => ({ time: ts, open: o, high: h, low: l, close: c, volume: vol }))
          .sort((a, b) => a.time - b.time);
        if (candles.length > 0) {
          return NextResponse.json({ poolAddress, candles, source: "geckoterminal" }, {
            headers: { "Cache-Control": "public, max-age=30" }
          });
        }
      }
    }
  } catch {
    // fall through to mock
  }

  // Final fallback: mock in dev, empty in production
  if (IS_DEV) {
    const mockCount = Math.floor((TF_TIME_WINDOWS[timeframe] || 86400000) / ((TF_MAP[timeframe]?.agg || 1) * 60000));
    const mockCandles = generateMockCandles(mint, timeframe, Math.min(mockCount, 300));
    return NextResponse.json({ 
      candles: mockCandles, 
      source: "mock",
      mock: true 
    }, {
      headers: { "Cache-Control": "public, max-age=30" }
    });
  }
  return NextResponse.json({ candles: [], error: "no_data" });
}
