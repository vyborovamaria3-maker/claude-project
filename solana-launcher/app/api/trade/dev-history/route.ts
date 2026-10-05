// data-tag: api.trade.dev_history_v3
import { NextRequest, NextResponse } from "next/server";
import { buildDevHistoryReport } from "@/lib/trade/dev-history-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const DEFAULT_DEV_HISTORY_HTTP_TIMEOUT_MS = 10_000;

function devHistoryHttpTimeoutMs(): number {
  const configured = Number(process.env.DEV_HISTORY_HTTP_TIMEOUT_MS || DEFAULT_DEV_HISTORY_HTTP_TIMEOUT_MS);
  if (!Number.isFinite(configured)) return DEFAULT_DEV_HISTORY_HTTP_TIMEOUT_MS;
  return Math.max(1_000, Math.min(30_000, Math.floor(configured)));
}

async function buildDevHistoryReportWithDeadline(
  args: Parameters<typeof buildDevHistoryReport>[0],
): Promise<Awaited<ReturnType<typeof buildDevHistoryReport>>> {
  const timeoutMs = devHistoryHttpTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<Awaited<ReturnType<typeof buildDevHistoryReport>>>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[dev-history] live report exceeded ${timeoutMs}ms; returning explicit unknown state`);
      resolve({
        available: false,
        creator: args.creator ?? null,
        mint: args.mint ?? null,
        reason: "DEV history timed out; live source is temporarily unavailable",
        status: 200,
        sourceStatus: "timeout",
      } as Awaited<ReturnType<typeof buildDevHistoryReport>>);
    }, timeoutMs);
  });
  try {
    return await Promise.race([buildDevHistoryReport(args), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function GET(req: NextRequest) {
  const mint = req.nextUrl.searchParams.get("mint")?.trim() || null;
  const creator = req.nextUrl.searchParams.get("creator")?.trim() || null;
  const refresh = req.nextUrl.searchParams.get("refresh") === "1";

  if (!mint && !creator) return NextResponse.json({ error: "mint or creator required" }, { status: 400 });
  if (mint && !ADDR_RE.test(mint)) return NextResponse.json({ error: "invalid mint" }, { status: 400 });
  if (creator && !ADDR_RE.test(creator)) return NextResponse.json({ error: "invalid creator" }, { status: 400 });

  const report = await buildDevHistoryReportWithDeadline({ mint, creator, refresh });
  if (!report.available && report.status >= 400) {
    return NextResponse.json(report, { status: report.status });
  }
  return NextResponse.json(report);
}
