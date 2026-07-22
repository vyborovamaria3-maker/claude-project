import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  return NextResponse.json(
    { error: "token-unified disabled: use token-trades, token-history, and token-ohlcv endpoints" },
    { status: 501 }
  );
}
