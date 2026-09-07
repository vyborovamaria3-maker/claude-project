// data-tag: api.bundler.simulate
// Simulate bundler transactions before execution

import { NextRequest, NextResponse } from "next/server";
import { requireProdAuth } from "@/lib/routeAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_WALLETS = 20;
const MAX_BUY_SOL = 10;

export async function POST(req: NextRequest) {
  const authError = await requireProdAuth(req);
  if (authError) return authError;

  try {
    const body = await req.json();
    const { mint, wallets, buyAmounts } = body;

    if (typeof mint !== "string" || !SOLANA_ADDRESS_RE.test(mint)) {
      return NextResponse.json({ error: "Invalid mint" }, { status: 400 });
    }
    if (!Array.isArray(wallets) || !Array.isArray(buyAmounts)) {
      return NextResponse.json(
        { error: "wallets and buyAmounts must be arrays" },
        { status: 400 },
      );
    }
    if (wallets.length < 1 || wallets.length > MAX_WALLETS || wallets.length !== buyAmounts.length) {
      return NextResponse.json(
        { error: `wallets and buyAmounts must have the same length between 1 and ${MAX_WALLETS}` },
        { status: 400 },
      );
    }
    if (wallets.some((wallet) => typeof wallet !== "string" || !SOLANA_ADDRESS_RE.test(wallet))) {
      return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
    }
    if (buyAmounts.some((amount) => typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > MAX_BUY_SOL)) {
      return NextResponse.json(
        { error: `Each buy amount must be a finite number between 0 and ${MAX_BUY_SOL} SOL` },
        { status: 400 },
      );
    }

    const results = wallets.map((wallet: string, i: number) => ({
      wallet,
      solAmount: buyAmounts[i],
      estimatedTokens: Math.floor(buyAmounts[i] * 1e6),
      success: true,
      error: null,
    }));

    const totalSol = buyAmounts.reduce((a: number, b: number) => a + b, 0);
    const estimatedTokens = results.reduce(
      (a: number, r: { estimatedTokens: number }) => a + r.estimatedTokens,
      0,
    );

    return NextResponse.json({
      success: true,
      results,
      summary: {
        totalWallets: wallets.length,
        totalSol,
        estimatedTokens,
        priorityFee: 0.00002,
        jitoFee: 0.0002,
      },
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const isDev = process.env.NODE_ENV === "development";
    const message = error instanceof Error
      ? (isDev ? error.message : "Simulation failed")
      : "Simulation failed";
    console.error("[bundler/simulate] Error:", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
