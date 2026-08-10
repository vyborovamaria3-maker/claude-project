import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const revalidate = 60;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MAX_FUTURE_SKEW = 5 * 60 * 1000;
const LIVE_MAX_AGE = 10 * 60 * 1000;
const MIN_WINDOW_SPAN = 20 * HOUR;
const MAX_CHART_POINTS = 120;

type PriceRow = [number, number];

type CoinGeckoChart = {
  prices?: PriceRow[];
  market_caps?: PriceRow[];
  total_volumes?: PriceRow[];
};

type MarketPoint = { time: number; price: number };

type MarketPayload = {
  price: number;
  change24h: number;
  high24h: number;
  low24h: number;
  volume24h: number | null;
  marketCap: number | null;
  updatedAt: number;
  servedAt: number;
  windowStart: number;
  windowEnd: number;
  sourcePointCount: number;
  plottedPointCount: number;
  stale: boolean;
  staleReason: "delayed_source" | "upstream_error" | null;
  points: MarketPoint[];
  source: "CoinGecko";
  quote: "USD";
};

let lastGoodPayload: MarketPayload | null = null;

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

function lastFiniteValue(rows: unknown, now: number): number | null {
  const normalized = normalizeRows(rows, now);
  return normalized.length ? normalized[normalized.length - 1][1] : null;
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
    .slice(0, maxPoints)
    .map((index) => rows[index]);
}

function marketHeaders(stale: boolean) {
  return {
    "Cache-Control": stale
      ? "public, s-maxage=30, stale-while-revalidate=300"
      : "public, s-maxage=60, stale-while-revalidate=300",
    "X-POTAPoff-Market-Source": "CoinGecko",
    "X-POTAPoff-Market-Stale": stale ? "1" : "0",
  };
}

export async function GET() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6_000);
  const servedAt = Date.now();

  try {
    const apiKey = process.env.COINGECKO_API_KEY?.trim();
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey) headers["x-cg-demo-api-key"] = apiKey;

    const response = await fetch(
      "https://api.coingecko.com/api/v3/coins/solana/market_chart?vs_currency=usd&days=1&precision=full",
      {
        headers,
        signal: controller.signal,
        next: { revalidate: 60 },
      },
    );

    if (!response.ok) {
      throw new Error(`CoinGecko responded with ${response.status}`);
    }

    const data = (await response.json()) as CoinGeckoChart;
    const normalized = normalizeRows(data.prices, servedAt);
    if (normalized.length < 24) throw new Error("Not enough valid Solana market points");

    const sourceEnd = normalized[normalized.length - 1][0];
    const sourceStart = sourceEnd - DAY;
    const prices = normalized.filter(([time]) => time >= sourceStart && time <= sourceEnd);

    if (prices.length < 24) throw new Error("Incomplete Solana 24h market window");
    if (prices[prices.length - 1][0] - prices[0][0] < MIN_WINDOW_SPAN) {
      throw new Error("Solana market window is too short");
    }

    const first = prices[0][1];
    const last = prices[prices.length - 1][1];
    const values = prices.map((row) => row[1]);
    const plotted = sampleRealPoints(prices, MAX_CHART_POINTS);
    const dataAge = Math.max(0, servedAt - sourceEnd);
    const stale = dataAge > LIVE_MAX_AGE;

    const payload: MarketPayload = {
      price: last,
      change24h: ((last - first) / first) * 100,
      high24h: Math.max(...values),
      low24h: Math.min(...values),
      volume24h: lastFiniteValue(data.total_volumes, servedAt),
      marketCap: lastFiniteValue(data.market_caps, servedAt),
      updatedAt: sourceEnd,
      servedAt,
      windowStart: prices[0][0],
      windowEnd: sourceEnd,
      sourcePointCount: prices.length,
      plottedPointCount: plotted.length,
      stale,
      staleReason: stale ? "delayed_source" : null,
      points: plotted.map(([time, price]) => ({ time, price })),
      source: "CoinGecko",
      quote: "USD",
    };

    lastGoodPayload = payload;

    return NextResponse.json(payload, {
      headers: marketHeaders(stale),
    });
  } catch (error) {
    if (lastGoodPayload) {
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
