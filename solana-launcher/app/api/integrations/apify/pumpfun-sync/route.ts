import { NextRequest, NextResponse } from "next/server";
import { getApifySummary, ingestPumpFunDataset, refreshApifyRun, runApifyActor, type PumpFunSyncInput } from "@/lib/apify";
import { requireProdSuperuser } from "@/lib/routeAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const authError = await requireProdSuperuser(request);
    if (authError) return authError;

    const summary = getApifySummary();
    return NextResponse.json({
      config: summary.config,
      latestRun: summary.latestPumpfunRun,
      recentRuns: summary.recentRuns.filter((run) => run.actorType === "pumpfun-scraper"),
      recentSyncs: summary.recentSyncs,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load Apify sync status" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const authError = await requireProdSuperuser(request);
    if (authError) return authError;

    const body = await request.json().catch(() => ({}));
    const action = typeof body?.action === "string" ? body.action : "start";

    if (action === "ingest") {
      const datasetId = typeof body?.datasetId === "string" ? body.datasetId.trim() : "";
      const runId = typeof body?.runId === "string" ? body.runId.trim() : null;
      if (!datasetId) {
        return NextResponse.json({ error: "datasetId is required for ingest" }, { status: 400 });
      }
      const event = await ingestPumpFunDataset(datasetId, runId);
      return NextResponse.json({ ok: true, event });
    }

    if (action === "refresh-run") {
      const runId = typeof body?.runId === "string" ? body.runId.trim() : "";
      if (!runId) {
        return NextResponse.json({ error: "runId is required for refresh-run" }, { status: 400 });
      }
      const run = await refreshApifyRun(runId);
      return NextResponse.json({ ok: true, run });
    }

    const input: PumpFunSyncInput = typeof body?.input === "object" && body?.input !== null ? body.input : {};
    const run = await runApifyActor("pumpfun-scraper", {
      maxItems: input.maxItems ?? 100,
      sortBy: input.sortBy ?? "last_trade_timestamp",
      order: input.order ?? "DESC",
      includeNsfw: input.includeNsfw ?? false,
      includeDetails: input.includeDetails ?? true,
    });
    return NextResponse.json({ ok: true, run });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to process Apify sync request" },
      { status: 500 },
    );
  }
}
