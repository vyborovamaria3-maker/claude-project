import { NextRequest, NextResponse } from "next/server";
import { refreshApifyRun } from "@/lib/apify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, context: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await context.params;
    const run = await refreshApifyRun(runId);
    return NextResponse.json({ ok: true, run });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to refresh Apify run" },
      { status: 500 },
    );
  }
}
