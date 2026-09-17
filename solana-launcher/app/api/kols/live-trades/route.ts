import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BACKEND_BASE = (process.env.BACKEND_URL || "http://backend:8000").replace(/\/$/, "");
const KOL_INTERNAL_KEY = process.env.KOL_INTERNAL_KEY || (
  process.env.NODE_ENV !== "production"
    ? process.env.BACKEND_API_KEY || process.env.INTERNAL_API_KEY || ""
    : ""
);

export async function GET(request: NextRequest) {
  if (!KOL_INTERNAL_KEY) {
    return NextResponse.json({ error: "KOL internal key is not configured" }, { status: 503 });
  }
  const rawLimit = Number(request.nextUrl.searchParams.get("limit") || 50);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, rawLimit)) : 50;
  try {
    const response = await fetch(`${BACKEND_BASE}/api/v1/kols/internal/live-trades?limit=${limit}`, {
      headers: { "X-KOL-Internal-Key": KOL_INTERNAL_KEY },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    const payload = await response.json().catch(() => ({}));
    return NextResponse.json(payload, {
      status: response.status,
      headers: { "cache-control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "KOL live feed unavailable" },
      { status: 502, headers: { "cache-control": "private, no-store, max-age=0" } },
    );
  }
}
