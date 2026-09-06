import { NextRequest, NextResponse } from "next/server";
import { getApifySummary } from "@/lib/apify";
import { requireProdAuth } from "@/lib/routeAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const authError = await requireProdAuth(request);
  if (authError) return authError;

  try {
    return NextResponse.json(getApifySummary(), {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load Apify summary" },
      { status: 500 },
    );
  }
}
