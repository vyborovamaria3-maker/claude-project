import { NextRequest, NextResponse } from "next/server";
import { getKols } from "@/lib/kols/resolver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseTimeframe(value: string | null): 1 | 7 | 30 {
  return value === "1" || value === "30" ? Number(value) as 1 | 30 : 7;
}

function parseBoolean(value: string | null) {
  return value === "1" || value === "true";
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
