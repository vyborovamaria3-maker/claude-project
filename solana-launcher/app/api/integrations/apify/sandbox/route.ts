import { NextRequest, NextResponse } from "next/server";
import { getApifySummary, runApifyActor } from "@/lib/apify";
import { requireProdAuth } from "@/lib/routeAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ sandbox: getApifySummary().latestSandboxRun, config: getApifySummary().config });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load sandbox status" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const authError = await requireProdAuth(request);
    if (authError) return authError;

    const body = await request.json().catch(() => ({}));
    const input = typeof body?.input === "object" && body?.input !== null ? body.input : {};
    const sandboxRun = await runApifyActor("sandbox", input);
    return NextResponse.json({ ok: true, run: sandboxRun });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to start Apify sandbox" },
      { status: 500 },
    );
  }
}
