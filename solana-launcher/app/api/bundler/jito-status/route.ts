// data-tag: api.bundler.jito_status
// Check Jito bundle status

import { NextRequest, NextResponse } from "next/server";
import { requireProdAuth } from "@/lib/routeAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const JITO_ENDPOINTS: Record<string, string> = {
  frankfurt: "https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles",
  ny: "https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles",
  tokyo: "https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles",
};
const BUNDLE_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;

export async function GET(req: NextRequest) {
  const authError = await requireProdAuth(req);
  if (authError) return authError;

  const bundleId = req.nextUrl.searchParams.get("bundleId")?.trim() || "";
  const region = req.nextUrl.searchParams.get("region") || "frankfurt";

  if (!BUNDLE_ID_RE.test(bundleId)) {
    return NextResponse.json(
      { error: "Invalid bundleId" },
      { status: 400 },
    );
  }

  const endpoint = JITO_ENDPOINTS[region];
  if (!endpoint) {
    return NextResponse.json(
      { error: "Invalid region" },
      { status: 400 },
    );
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getBundleStatuses",
        params: [[bundleId]],
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) {
      return NextResponse.json({ error: "Jito status service unavailable" }, { status: 502 });
    }
    const data = await response.json();
    return NextResponse.json(data, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Failed to check status" }, { status: 502 });
  }
}
