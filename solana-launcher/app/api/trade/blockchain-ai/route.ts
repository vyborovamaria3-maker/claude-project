import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { getBlockchainAiSnapshot } from "@/lib/trade/chain/ai-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function validMint(value: string): boolean {
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

async function handle(mint: string, refresh: boolean, detail: "compact" | "full") {
  const startedAt = Date.now();
  const result = await getBlockchainAiSnapshot(mint, { refresh });
  return NextResponse.json({
    available: true,
    mint,
    detail,
    latencyMs: Date.now() - startedAt,
    cacheHit: result.cacheHit,
    cacheAgeMs: result.cacheAgeMs,
    snapshot: detail === "full" ? result.snapshot : result.compact,
  });
}

export async function GET(req: NextRequest) {
  const mint = req.nextUrl.searchParams.get("mint")?.trim() || "";
  if (!validMint(mint)) return NextResponse.json({ error: "invalid mint" }, { status: 400 });
  const refresh = req.nextUrl.searchParams.get("refresh") === "1";
  const detail = req.nextUrl.searchParams.get("detail") === "full" ? "full" : "compact";
  try {
    return await handle(mint, refresh, detail);
  } catch (error) {
    console.error("[blockchain-ai] snapshot failed", error);
    return NextResponse.json(
      { available: false, error: "blockchain AI snapshot failed" },
      { status: 502 },
    );
  }
}

export async function POST(req: NextRequest) {
  let body: { mint?: string; refresh?: boolean; detail?: "compact" | "full" };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const mint = String(body.mint || "").trim();
  if (!validMint(mint)) return NextResponse.json({ error: "invalid mint" }, { status: 400 });
  try {
    return await handle(mint, body.refresh === true, body.detail === "full" ? "full" : "compact");
  } catch (error) {
    console.error("[blockchain-ai] snapshot failed", error);
    return NextResponse.json(
      { available: false, error: "blockchain AI snapshot failed" },
      { status: 502 },
    );
  }
}
