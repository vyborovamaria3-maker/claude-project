// data-tag: api.bundler.simulate
// Simulate bundler transactions before execution

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { mint, wallets, buyAmounts } = body;

    if (!mint || !wallets || !buyAmounts) {
      return NextResponse.json(
        { error: "Missing required fields: mint, wallets, buyAmounts" },
        { status: 400 }
      );
    }

    // Simulation logic
    const results = wallets.map((wallet: string, i: number) => ({
      wallet,
      solAmount: buyAmounts[i],
      estimatedTokens: Math.floor(buyAmounts[i] * 1e6), // Simplified
      success: true,
      error: null,
    }));

    const totalSol = buyAmounts.reduce((a: number, b: number) => a + b, 0);
    const estimatedTokens = results.reduce(
      (a: number, r: { estimatedTokens: number }) => a + r.estimatedTokens,
      0
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
    });
  } catch (error) {
    const isDev = process.env.NODE_ENV === "development";
    const message = error instanceof Error 
      ? (isDev ? error.message : "Simulation failed")
      : "Simulation failed";
    console.error("[bundler/simulate] Error:", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
