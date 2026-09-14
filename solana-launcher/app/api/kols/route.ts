import { NextRequest, NextResponse } from "next/server";
import { getKols } from "@/lib/kols/resolver";
import type { KolListResponse } from "@/lib/kols/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BACKEND_BASE = (process.env.BACKEND_URL || "http://backend:8000").replace(/\/$/, "");
const BACKEND_KEY = process.env.BACKEND_API_KEY || process.env.INTERNAL_API_KEY || "";

function parseTimeframe(value: string | null): 1 | 7 | 30 {
  return value === "1" || value === "30" ? Number(value) as 1 | 30 : 7;
}

function parseBoolean(value: string | null) {
  return value === "1" || value === "true";
}

async function persistKols(payload: KolListResponse, exactQuery: boolean) {
  if (!BACKEND_KEY || payload.items.length === 0) return;
  const items = exactQuery ? payload.items : payload.items.slice(0, 50);
  try {
    await fetch(`${BACKEND_BASE}/api/v1/kols/sync`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Backend-API-Key": BACKEND_KEY,
      },
      body: JSON.stringify({ items, sourceStatus: payload.sourceStatus }),
      cache: "no-store",
      signal: AbortSignal.timeout(4_000),
    });
  } catch {
    // Persistence is enrichment only. Fresh public-source lookup must remain usable
    // when the backend is unavailable or migrations have not been applied yet.
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
    return NextResponse.json(payload, {
      headers: {
        "cache-control": query
          ? "private, no-store"
          : "public, s-maxage=300, stale-while-revalidate=900",
      },
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
      { status: 502 },
    );
  }
}