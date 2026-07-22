import { NextRequest, NextResponse } from "next/server";
import { analyzePumpFunCreatorFee } from "../../../../lib/trade/creator-fee-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function GET(req: NextRequest) {
  const mint = req.nextUrl.searchParams.get("mint")?.trim() || "";
  const bondingCurveAddress = req.nextUrl.searchParams.get("bondingCurveAddress")?.trim() || undefined;
  const isMigratedToRaydium = req.nextUrl.searchParams.get("isMigratedToRaydium") === "true";

  if (!SOLANA_ADDRESS_RE.test(mint)) {
    return NextResponse.json({ error: "invalid mint" }, { status: 400 });
  }

  try {
    const report = await analyzePumpFunCreatorFee({
      mint,
      bondingCurveAddress,
      isMigratedToRaydium,
    });

    return NextResponse.json(report);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "creator fee analysis failed" },
      { status: 500 },
    );
  }
}
