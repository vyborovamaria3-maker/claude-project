import { NextRequest, NextResponse } from "next/server";
import { getXCollectorSummary, runXCollectorAction, type XCollectorAction } from "@/lib/xcollector";
import { requireProdAuth } from "@/lib/routeAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getXCollectorSummary());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load X Collector summary" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const authError = await requireProdAuth(request);
    if (authError) return authError;

    const body = await request.json().catch(() => ({}));
    const action = typeof body?.action === "string" ? (body.action as XCollectorAction) : null;
    if (!action) {
      return NextResponse.json({ error: "action is required" }, { status: 400 });
    }

    const result = await runXCollectorAction(action);
    return NextResponse.json({ action, ...result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to run X Collector action" },
      { status: 500 },
    );
  }
}
