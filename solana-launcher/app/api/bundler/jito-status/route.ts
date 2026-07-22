// data-tag: api.bundler.jito_status
// Check Jito bundle status

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const JITO_ENDPOINTS: Record<string, string> = {
  frankfurt: "https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles",
  ny: "https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles",
  tokyo: "https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles",
};

export async function GET(req: NextRequest) {
  const bundleId = req.nextUrl.searchParams.get("bundleId");
  const region = req.nextUrl.searchParams.get("region") || "frankfurt";

  if (!bundleId) {
    return NextResponse.json(
      { error: "bundleId required" },
      { status: 400 }
    );
  }

  const endpoint = JITO_ENDPOINTS[region];
  if (!endpoint) {
    return NextResponse.json(
      { error: "Invalid region" },
      { status: 400 }
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
    });

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to check status";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
