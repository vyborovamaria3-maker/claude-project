import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MAX_FUTURE_SKEW = 5 * 60 * 1000;
const LIVE_MAX_AGE = 10 * 60 * 1000;
const MIN_WINDOW_SPAN = 23 * HOUR;
const MAX_MARKET_DATA_AGE = 6 * HOUR;
const MAX_METRIC_SKEW = 30 * 60 * 1000;
const MAX_CHART_POINTS = 120;
const SOLANA_RANGE_START_2020 = Math.floor(Date.UTC(2020, 0, 1) / 1000);
const PERIODS = {
  "5m": { days: "1", windowMs: DAY, minPoints: 24 },
  "1h": { days: "7", windowMs: 7 * DAY, minPoints: 24 },
  "1d": { days: "1", windowMs: DAY, minPoints: 24 },
  "1w": { days: "7", windowMs: 7 * DAY, minPoints: 24 },
  all: { days: "max", windowMs: Number.POSITIVE_INFINITY, minPoints: 24 },
} as const;

type MarketPeriod = keyof typeof PERIODS;

type PriceRow = [number, number];

type CoinGeckoChart = {
  prices?: PriceRow[];
  market_caps?: PriceRow[];
  total_volumes?: PriceRow[];
};

type MarketPoint = { time: number; price: number };
type TimedMetric = { value: number | null; time: number | null };

type MarketPayload = {
  price: number;
  change24h: number;
  high24h: number;
  low24h: number;
  volume24h: number | null;
  volumeUpdatedAt: number | null;
  marketCap: number | null;
  marketCapUpdatedAt: number | null;
  updatedAt: number;
  servedAt: number;
  windowStart: number;
  windowEnd: number;
  sourcePointCount: number;
  plottedPointCount: number;
  stale: boolean;
  staleReason: "delayed_source" | "upstream_error" | null;
  points: MarketPoint[];
  source: "CoinGecko" | "Coinbase";
  quote: "USD";
};

const lastGoodPayloads = new Map<MarketPeriod, MarketPayload>();

function parsePeriod(raw: string | null): MarketPeriod {
  return raw && raw in PERIODS ? raw as MarketPeriod : "1d";
}

function isValidRow(row: unknown): row is PriceRow {
  return (
    Array.isArray(row) &&
    row.length >= 2 &&
    Number.isFinite(row[0]) &&
    Number.isFinite(row[1]) &&
    row[0] > 0 &&
    row[1] > 0
  );
}

function normalizeRows(rows: unknown, now: number): PriceRow[] {
  if (!Array.isArray(rows)) return [];

  const byTimestamp = new Map<number, number>();
  for (const row of rows) {
    if (!isValidRow(row)) continue;
    const [time, value] = row;
    if (time > now + MAX_FUTURE_SKEW) continue;
    byTimestamp.set(time, value);
  }

  return Array.from(byTimestamp.entries())
    .map(([time, value]) => [time, value] as PriceRow)
    .sort((a, b) => a[0] - b[0]);
}

function latestMetricNearCutoff(rows: unknown, cutoff: number, now: number): TimedMetric {
  const normalized = normalizeRows(rows, now);
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const [time, value] = normalized[index];
    if (time > cutoff) continue;
    if (cutoff - time > MAX_METRIC_SKEW) return { value: null, time: null };
    return { value, time };
  }
  return { value: null, time: null };
}

async function fetchCoinbaseSolHistory(fromSec: number, toSec: number, signal: AbortSignal): Promise<CoinGeckoChart | null> {
  type CoinbaseCandle = [number, number, number, number, number, number];
  const granularitySec = 86_400;
  const maxCandles = 300;
  const prices: PriceRow[] = [];
  const volumes: PriceRow[] = [];
  let cursorEndSec = toSec;

  while (cursorEndSec > fromSec) {
    const cursorStartSec = Math.max(fromSec, cursorEndSec - granularitySec * maxCandles);
    const start = new Date(cursorStartSec * 1000).toISOString();
    const end = new Date(cursorEndSec * 1000).toISOString();
    const response = await fetch(
      `https://api.exchange.coinbase.com/products/SOL-USD/candles?granularity=${granularitySec}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
      {
        headers: { Accept: "application/json" },
        signal,
        cache: "no-store",
      },
    );

    if (!response.ok) break;
    const rows = await response.json() as CoinbaseCandle[];
    if (!Array.isArray(rows) || rows.length === 0) {
      cursorEndSec = cursorStartSec - granularitySec;
      continue;
    }

    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 6) continue;
      const [timeSec, , , , close, volume] = row;
      if (!Number.isFinite(timeSec) || !Number.isFinite(close) || close <= 0) continue;
      const timeMs = timeSec * 1000;
      prices.push([timeMs, close]);
      if (Number.isFinite(volume) && volume > 0) volumes.push([timeMs, volume * close]);
    }

    cursorEndSec = cursorStartSec - granularitySec;
  }

  const normalized = normalizeRows(prices, toSec * 1000);
  if (normalized.length < 24) return null;
  return {
    prices: normalized,
    total_volumes: normalizeRows(volumes, toSec * 1000),
  };
}

/**
 * Keep only points that actually exist in the upstream market series.
 * No interpolation or synthetic prices are generated. The first/last and
 * true 24h high/low observations are explicitly retained in the SVG series.
 */
function sampleRealPoints(rows: PriceRow[], maxPoints: number): PriceRow[] {
  if (rows.length <= maxPoints) return rows;

  let highIndex = 0;
  let lowIndex = 0;
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index][1] > rows[highIndex][1]) highIndex = index;
    if (rows[index][1] < rows[lowIndex][1]) lowIndex = index;
  }

  const selected = new Set<number>([0, rows.length - 1, highIndex, lowIndex]);
  const step = (rows.length - 1) / Math.max(1, maxPoints - 1);

  for (let index = 0; index < maxPoints && selected.size < maxPoints; index += 1) {
    selected.add(Math.round(index * step));
  }

  if (selected.size < maxPoints) {
    for (let index = 0; index < rows.length && selected.size < maxPoints; index += 1) {
      selected.add(index);
    }
  }

  return Array.from(selected)
    .sort((a, b) => a - b)
    .map((index) => rows[index]);
}

function marketHeaders(stale: boolean) {
  return {
    "Cache-Control": "no-store",
    "X-POTAPoff-Market-Source": "CoinGecko",
    "X-POTAPoff-Market-Stale": stale ? "1" : "0",
  };
}

export async function GET(request: NextRequest) {
  const period = parsePeriod(request.nextUrl.searchParams.get("period"));
  const periodConfig = PERIODS[period];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), period === "all" ? 15_000 : 6_000);
  const servedAt = Date.now();

  try {
    const apiKey = process.env.COINGECKO_API_KEY?.trim();
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey) headers["x-cg-demo-api-key"] = apiKey;

    const chartUrl = period === "all"
      ? `https://api.coingecko.com/api/v3/coins/solana/market_chart/range?vs_currency=usd&from=${SOLANA_RANGE_START_2020}&to=${Math.floor(servedAt / 1000)}&precision=full`
      : `https://api.coingecko.com/api/v3/coins/solana/market_chart?vs_currency=usd&days=${periodConfig.days}&precision=full`;

    const response = await fetch(
      chartUrl,
      {
        headers,
        signal: controller.signal,
        next: { revalidate: 60 },
      },
    );

    let data: CoinGeckoChart | null = null;
    let source: MarketPayload["source"] = "CoinGecko";
    if (response.ok) {
      data = (await response.json()) as CoinGeckoChart;
    } else if (period === "all") {
      data = await fetchCoinbaseSolHistory(SOLANA_RANGE_START_2020, Math.floor(servedAt / 1000), controller.signal);
      if (data) source = "Coinbase";
    }

    if (!data) throw new Error(`Market source responded with ${response.status}`);
    const normalized = normalizeRows(data.prices, servedAt);
    if (normalized.length < periodConfig.minPoints) throw new Error("Not enough valid Solana market points");

    const sourceEnd = normalized[normalized.length - 1][0];
    const sourceStart = Number.isFinite(periodConfig.windowMs) ? sourceEnd - periodConfig.windowMs : normalized[0][0];
    let prices = normalized.filter(([time]) => time >= sourceStart && time <= sourceEnd);
    if (prices.length < periodConfig.minPoints) throw new Error("Incomplete Solana market window");
    if (period === "1d" && prices[prices.length - 1][0] - prices[0][0] < MIN_WINDOW_SPAN) {
      throw new Error("Solana market window is too short");
    }

    const first = prices[0][1];
    const last = prices[prices.length - 1][1];
    const values = prices.map((row) => row[1]);
    const plotted = sampleRealPoints(prices, MAX_CHART_POINTS);
    const dataAge = Math.max(0, servedAt - sourceEnd);
    if (period !== "all" && dataAge > MAX_MARKET_DATA_AGE) {
      throw new Error("Solana market source is too old");
    }
    const stale = dataAge > LIVE_MAX_AGE;
    const volume = latestMetricNearCutoff(data.total_volumes, sourceEnd, servedAt);
    const marketCap = latestMetricNearCutoff(data.market_caps, sourceEnd, servedAt);

    const payload: MarketPayload = {
      price: last,
      change24h: ((last - first) / first) * 100,
      high24h: Math.max(...values),
      low24h: Math.min(...values),
      volume24h: volume.value,
      volumeUpdatedAt: volume.time,
      marketCap: marketCap.value,
      marketCapUpdatedAt: marketCap.time,
      updatedAt: sourceEnd,
      servedAt,
      windowStart: prices[0][0],
      windowEnd: sourceEnd,
      sourcePointCount: prices.length,
      plottedPointCount: plotted.length,
      stale,
      staleReason: stale ? "delayed_source" : null,
      points: plotted.map(([time, price]) => ({ time, price })),
      source,
      quote: "USD",
    };

    lastGoodPayloads.set(period, payload);

    return NextResponse.json(payload, {
      headers: marketHeaders(stale),
    });
  } catch (error) {
    const lastGoodPayload = lastGoodPayloads.get(period);
    const fallbackAge = lastGoodPayload
      ? Math.max(0, servedAt - lastGoodPayload.updatedAt)
      : Number.POSITIVE_INFINITY;

    if (lastGoodPayload && fallbackAge <= MAX_MARKET_DATA_AGE) {
      const fallback: MarketPayload = {
        ...lastGoodPayload,
        servedAt,
        stale: true,
        staleReason: "upstream_error",
      };

      return NextResponse.json(fallback, {
        headers: marketHeaders(true),
      });
    }

    return NextResponse.json(
      {
        error: "Solana market data is temporarily unavailable",
        detail: error instanceof Error ? error.message : "Unknown market data error",
      },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } finally {
    clearTimeout(timeout);
  }
}
