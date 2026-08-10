import { NextRequest, NextResponse } from "next/server";
import { getApifySummary, ingestPumpFunDataset, refreshApifyRun, runApifyActor, type PumpFunSyncInput } from "@/lib/apify";
import { requireProdAuth } from "@/lib/routeAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const APIFY_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ALLOWED_SORT_BY = new Set(["last_trade_timestamp", "created_timestamp", "market_cap", "usd_market_cap"]);
const ALLOWED_ORDER = new Set(["ASC", "DESC"]);

function validApifyId(value: string): boolean {
  return APIFY_ID_RE.test(value);
}

export async function GET(request: NextRequest) {
  const authError = await requireProdAuth(request);
  if (authError) return authError;

  try {
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
  const authError = await requireProdAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json().catch(() => ({}));
    const action = typeof body?.action === "string" ? body.action : "start";

    if (!new Set(["start", "ingest", "refresh-run"]).has(action)) {
      return NextResponse.json({ error: "unsupported action" }, { status: 400 });
    }

    if (action === "ingest") {
      const datasetId = typeof body?.datasetId === "string" ? body.datasetId.trim() : "";
      const runId = typeof body?.runId === "string" ? body.runId.trim() : null;
      if (!datasetId || !validApifyId(datasetId)) {
        return NextResponse.json({ error: "valid datasetId is required for ingest" }, { status: 400 });
      }
      if (runId && !validApifyId(runId)) {
        return NextResponse.json({ error: "invalid runId" }, { status: 400 });
      }
      const event = await ingestPumpFunDataset(datasetId, runId);
      return NextResponse.json({ ok: true, event });
    }

    if (action === "refresh-run") {
      const runId = typeof body?.runId === "string" ? body.runId.trim() : "";
      if (!runId || !validApifyId(runId)) {
        return NextResponse.json({ error: "valid runId is required for refresh-run" }, { status: 400 });
      }
      const run = await refreshApifyRun(runId);
      return NextResponse.json({ ok: true, run });
    }

    const input: PumpFunSyncInput = typeof body?.input === "object" && body?.input !== null ? body.input : {};
    const maxItemsRaw = Number(input.maxItems ?? 100);
    if (!Number.isInteger(maxItemsRaw) || maxItemsRaw < 1 || maxItemsRaw > 500) {
      return NextResponse.json({ error: "maxItems must be an integer between 1 and 500" }, { status: 400 });
    }
    const sortBy = String(input.sortBy ?? "last_trade_timestamp");
    const order = String(input.order ?? "DESC").toUpperCase();
    if (!ALLOWED_SORT_BY.has(sortBy) || !ALLOWED_ORDER.has(order)) {
      return NextResponse.json({ error: "invalid sortBy or order" }, { status: 400 });
    }

    const run = await runApifyActor("pumpfun-scraper", {
      maxItems: maxItemsRaw,
      sortBy,
      order: order as "ASC" | "DESC",
      includeNsfw: input.includeNsfw === true,
      includeDetails: input.includeDetails !== false,
    });
    return NextResponse.json({ ok: true, run });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to process Apify sync request" },
      { status: 500 },
    );
  }
}
