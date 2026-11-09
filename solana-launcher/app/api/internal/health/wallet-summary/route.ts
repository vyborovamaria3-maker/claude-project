import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../../lib/trade/db";
import { getWalletSummaryStatus } from "../../../../../lib/trade/wallet-summary";
import { hasValidInternalServiceKey } from "../../../../../lib/routeAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Internal deployment health probe. It returns readiness only and never
 * exposes wallet rows, addresses, source signatures or database paths.
 */
export async function GET(request: NextRequest) {
  if (!hasValidInternalServiceKey(request)) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const status = getWalletSummaryStatus(getDb());
  if (!status.ready) {
    return NextResponse.json(
      { ok: false, walletSummary: "stale", reason: status.reason },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    { ok: true, walletSummary: "ready" },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
