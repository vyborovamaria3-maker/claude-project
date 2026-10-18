import { NextResponse } from "next/server";
import { rpcRequest } from "../../../scripts/blockchain-runtime.cjs";

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
    const payload = await rpcRequest(RPC_URL, {
        jsonrpc: "2.0",
        id: 1,
        method: "getHealth",
    });

    const latency = Date.now() - startedAt;

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
