import { NextRequest, NextResponse } from "next/server";
import { getKols } from "@/lib/kols/resolver";
import type { KolListResponse, KolWallet } from "@/lib/kols/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BACKEND_BASE = (process.env.BACKEND_URL || "http://backend:8000").replace(/\/$/, "");
const KOL_INTERNAL_KEY = process.env.KOL_INTERNAL_KEY || (
  process.env.NODE_ENV !== "production"
    ? process.env.BACKEND_API_KEY || process.env.INTERNAL_API_KEY || ""
    : ""
);

type InternalMetric = {
  timeframeDays: number;
  source?: string;
  realizedPnlUsd?: number | null;
  winRate?: number | null;
  wins?: number | null;
  losses?: number | null;
  lastTradeAt?: string | null;
};

type InternalMetricItem = {
  address: string;
  chain: "solana";
  metrics: InternalMetric[];
};

type InternalMetricResponse = { items?: InternalMetricItem[] };

function parseTimeframe(value: string | null): 1 | 7 | 30 {
  return value === "1" || value === "30" ? Number(value) as 1 | 30 : 7;
}

function parseBoolean(value: string | null) {
  return value === "1" || value === "true";
}

async function persistKols(payload: KolListResponse, exactQuery: boolean) {
  if (!KOL_INTERNAL_KEY || payload.items.length === 0) return;
  const items = exactQuery ? payload.items : payload.items.slice(0, 50);
  try {
    const response = await fetch(`${BACKEND_BASE}/api/v1/kols/internal/sync`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-KOL-Internal-Key": KOL_INTERNAL_KEY,
      },
      body: JSON.stringify({ items, sourceStatus: payload.sourceStatus }),
      cache: "no-store",
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) throw new Error(`KOL sync HTTP ${response.status}`);
  } catch {
    // Persistence is enrichment only. Fresh public-source lookup must remain usable
    // when the backend is unavailable or migrations have not been applied yet.
  }
}

function applyInternalMetric(wallet: KolWallet, metric: InternalMetric) {
  const days = metric.timeframeDays;
  if (days === 1) {
    if (metric.realizedPnlUsd != null) wallet.metrics.realizedPnl1dUsd = metric.realizedPnlUsd;
    if (metric.wins != null) wallet.metrics.wins1d = metric.wins;
    if (metric.losses != null) wallet.metrics.losses1d = metric.losses;
    if (metric.winRate != null) wallet.metrics.winRate1d = metric.winRate;
  } else if (days === 7) {
    if (metric.realizedPnlUsd != null) wallet.metrics.realizedPnl7dUsd = metric.realizedPnlUsd;
    if (metric.wins != null) wallet.metrics.wins7d = metric.wins;
    if (metric.losses != null) wallet.metrics.losses7d = metric.losses;
    if (metric.winRate != null) wallet.metrics.winRate7d = metric.winRate;
  } else if (days === 30) {
    if (metric.realizedPnlUsd != null) wallet.metrics.realizedPnl30dUsd = metric.realizedPnlUsd;
    if (metric.wins != null) wallet.metrics.wins30d = metric.wins;
    if (metric.losses != null) wallet.metrics.losses30d = metric.losses;
    if (metric.winRate != null) wallet.metrics.winRate30d = metric.winRate;
  }
  if (metric.lastTradeAt && (!wallet.metrics.lastTradeAt || metric.lastTradeAt > wallet.metrics.lastTradeAt)) {
    wallet.metrics.lastTradeAt = metric.lastTradeAt;
  }
  if (metric.source) wallet.metrics.internalSource = metric.source;
}

async function mergeInternalMetrics(payload: KolListResponse) {
  if (!KOL_INTERNAL_KEY) return;
  const addresses = Array.from(
    new Set(
      payload.items.flatMap((profile) =>
        profile.wallets
          .filter((wallet) => wallet.chain === "solana")
          .map((wallet) => wallet.address),
      ),
    ),
  ).slice(0, 500);
  if (addresses.length === 0) return;

  try {
    const response = await fetch(`${BACKEND_BASE}/api/v1/kols/internal/metrics`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-KOL-Internal-Key": KOL_INTERNAL_KEY,
      },
      body: JSON.stringify({ addresses }),
      cache: "no-store",
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) throw new Error(`internal metrics HTTP ${response.status}`);
    const data = (await response.json()) as InternalMetricResponse;
    // Solana base58 addresses are case-sensitive. Never lowercase them for identity joins.
    const lookup = new Map(
      (data.items ?? []).map((item) => [item.address, item.metrics] as const),
    );
    let mergedWallets = 0;
    for (const profile of payload.items) {
      for (const wallet of profile.wallets) {
        if (wallet.chain !== "solana") continue;
        const metrics = lookup.get(wallet.address);
        if (!metrics?.length) continue;
        for (const metric of metrics) applyInternalMetric(wallet, metric);
        mergedWallets += 1;
      }
    }
    payload.sourceStatus.push({
      source: "Internal wallet trades",
      ok: true,
      detail: `${mergedWallets} wallet metric set(s) merged`,
    });
  } catch (error) {
    payload.sourceStatus.push({
      source: "Internal wallet trades",
      ok: false,
      detail: error instanceof Error ? error.message : "internal metrics unavailable",
    });
  }
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const query = params.get("query")?.trim() || "";
  const timeframe = parseTimeframe(params.get("timeframe"));
  const limit = Number(params.get("limit") || 100);
  const minConfidence = Number(params.get("minConfidence") || 0);

  try {
    const payload = await getKols({
      query,
      timeframe,
      limit: Number.isFinite(limit) ? limit : 100,
      minConfidence: Number.isFinite(minConfidence) ? minConfidence : 0,
      verifiedOnly: parseBoolean(params.get("verifiedOnly")),
    });
    await persistKols(payload, Boolean(query));
    await mergeInternalMetrics(payload);
    return NextResponse.json(payload, {
      headers: { "cache-control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "KOL lookup failed",
        items: [],
        total: 0,
        timeframe,
        generatedAt: new Date().toISOString(),
        sourceStatus: [],
      },
      { status: 502, headers: { "cache-control": "private, no-store, max-age=0" } },
    );
  }
}
