import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BACKEND_BASE = (process.env.BACKEND_URL || "http://backend:8000").replace(/\/$/, "");
const KOL_INTERNAL_KEY = process.env.KOL_INTERNAL_KEY || (
  process.env.NODE_ENV !== "production"
    ? process.env.BACKEND_API_KEY || process.env.INTERNAL_API_KEY || ""
    : ""
);

const ALLOWED_PARAMS = new Set([
  "lookbackDays",
  "minKols",
  "minConfidence",
  "windowMinutes",
  "cooldownMinutes",
  "costBps",
  "maxSignals",
  "strictAttributionTime",
]);

export async function GET(request: NextRequest) {
  if (!KOL_INTERNAL_KEY) {
    return NextResponse.json(
      { error: "KOL internal key is not configured" },
      { status: 503, headers: { "cache-control": "private, no-store, max-age=0" } },
    );
  }

  const query = new URLSearchParams();
  for (const [key, value] of request.nextUrl.searchParams.entries()) {
    if (ALLOWED_PARAMS.has(key)) query.set(key, value);
  }

  try {
    const suffix = query.size ? `?${query.toString()}` : "";
    const response = await fetch(`${BACKEND_BASE}/api/v1/kols/internal/backtest${suffix}`, {
      headers: { "X-KOL-Internal-Key": KOL_INTERNAL_KEY },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => ({}));
    return NextResponse.json(payload, {
      status: response.status,
      headers: { "cache-control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "KOL backtest unavailable" },
      { status: 502, headers: { "cache-control": "private, no-store, max-age=0" } },
    );
  }
}
