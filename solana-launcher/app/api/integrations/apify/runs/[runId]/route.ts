import { NextRequest, NextResponse } from "next/server";
import { refreshApifyRun } from "@/lib/apify";
import { requireProdAuth } from "@/lib/routeAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const APIFY_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export async function GET(request: NextRequest, context: { params: Promise<{ runId: string }> }) {
  const authError = await requireProdAuth(request);
  if (authError) return authError;

  try {
    const { runId } = await context.params;
    if (!APIFY_ID_RE.test(runId)) {
      return NextResponse.json({ error: "Invalid run id" }, { status: 400 });
    }
    const run = await refreshApifyRun(runId);
    return NextResponse.json(
      { ok: true, run },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to refresh Apify run" },
      { status: 500 },
    );
  }
}
