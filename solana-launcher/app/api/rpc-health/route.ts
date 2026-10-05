import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RPC_URL =
  process.env.HELIUS_RPC_URL ||
  process.env.NEXT_PUBLIC_HELIUS_RPC_URL ||
  process.env.RPC_URL ||
  process.env.NEXT_PUBLIC_RPC_URL ||
  "https://api.mainnet-beta.solana.com";

export async function GET() {
  const startedAt = Date.now();

  try {
    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getHealth",
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(4_500),
    });

    const latency = Date.now() - startedAt;

    if (!response.ok) {
      return NextResponse.json({
        status: "degraded",
        latency,
      });
    }

    const payload = await response.json().catch(() => null) as {
      result?: string;
      error?: unknown;
    } | null;

    return NextResponse.json({
      status: payload?.result === "ok" ? "ok" : "degraded",
      latency,
    });
  } catch {
    return NextResponse.json({
      status: "degraded",
      latency: null,
    });
  }
}
