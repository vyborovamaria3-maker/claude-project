import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const revalidate = 60;

type CoinGeckoChart = {
  prices?: [number, number][];
  market_caps?: [number, number][];
  total_volumes?: [number, number][];
};

type MarketPayload = {
  price: number;
  change24h: number;
  high24h: number;
  low24h: number;
  volume24h: number | null;
  marketCap: number | null;
  updatedAt: number;
  points: Array<{ time: number; price: number }>;
  source: "CoinGecko";
};

let lastGoodPayload: MarketPayload | null = null;

function sample<T>(items: T[], maxPoints: number): T[] {
  if (items.length <= maxPoints) return items;
  const step = (items.length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, index) => items[Math.round(index * step)]);
}

function lastValue(rows?: [number, number][]) {
  return rows?.length ? rows[rows.length - 1][1] : null;
}

export async function GET() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6_000);

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
    const prices = (data.prices ?? []).filter(
      (row): row is [number, number] =>
        Array.isArray(row) && Number.isFinite(row[0]) && Number.isFinite(row[1]) && row[1] > 0,
    );

    if (prices.length < 2) throw new Error("Not enough Solana market points");

    const first = prices[0][1];
    const last = prices[prices.length - 1][1];
    const values = prices.map((row) => row[1]);
    const sampled = sample(prices, 72);

    const payload: MarketPayload = {
      price: last,
      change24h: ((last - first) / first) * 100,
      high24h: Math.max(...values),
      low24h: Math.min(...values),
      volume24h: lastValue(data.total_volumes),
      marketCap: lastValue(data.market_caps),
      updatedAt: prices[prices.length - 1][0],
      points: sampled.map(([time, price]) => ({ time, price })),
      source: "CoinGecko",
    };

    lastGoodPayload = payload;

    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
      },
    });
  } catch (error) {
    if (lastGoodPayload) {
      return NextResponse.json(lastGoodPayload, {
        headers: {
          "Cache-Control": "public, s-maxage=30, stale-while-revalidate=300",
          "X-POTAPoff-Market-Stale": "1",
        },
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
