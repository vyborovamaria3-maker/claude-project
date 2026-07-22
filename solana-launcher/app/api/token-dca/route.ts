import { NextRequest, NextResponse } from "next/server";

// data-tag: api.token_dca
// Jupiter DCA open positions for a given output mint

export const runtime = "edge";

export async function GET(req: NextRequest) {
  const mint = req.nextUrl.searchParams.get("mint");
  if (!mint) return NextResponse.json({ error: "mint required" }, { status: 400 });

  try {
    // Jupiter DCA public endpoint
    const r = await fetch(`https://dca-api.jup.ag/dca/positions?outputMint=${mint}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!r.ok) {
      // Endpoint may be private now; return empty gracefully
      return NextResponse.json({ positions: [] });
    }
    const data = await r.json();
    return NextResponse.json({ positions: data.positions ?? data ?? [] });
  } catch {
    return NextResponse.json({ positions: [] });
  }
}
