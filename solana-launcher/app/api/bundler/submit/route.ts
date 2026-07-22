// data-tag: api.bundler.submit
// Submit bundle to Jito (server-side for security)

import { NextRequest, NextResponse } from "next/server";
import { requireProdAuth } from "@/lib/routeAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const JITO_ENDPOINTS: Record<string, string> = {
  frankfurt: "https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles",
  ny: "https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles",
  tokyo: "https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles",
};

export async function POST(req: NextRequest) {
  try {
    const authError = await requireProdAuth(req);
    if (authError) return authError;

    const body = await req.json();
    const { transactions, region = "frankfurt" } = body;

    if (!transactions || !Array.isArray(transactions)) {
      return NextResponse.json(
        { error: "transactions array required" },
        { status: 400 }
      );
    }

    if (transactions.length === 0 || transactions.length > 5) {
      return NextResponse.json(
        { error: "transactions must contain 1 to 5 signed transactions" },
        { status: 400 }
      );
    }

    if (transactions.some((tx) => typeof tx !== "string" || tx.length > 100_000)) {
      return NextResponse.json(
        { error: "Invalid transaction payload" },
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

    // Forward to Jito
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [transactions],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to submit";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
