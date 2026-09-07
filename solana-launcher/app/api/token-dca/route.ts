import { NextRequest, NextResponse } from "next/server";

// data-tag: api.token_dca
// Jupiter DCA open positions for a given output mint

export const runtime = "edge";

const UPSTREAM_TIMEOUT_MS = 5_000;

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET(req: NextRequest) {
  const mint = req.nextUrl.searchParams.get("mint")?.trim() || "";
  if (!mint) return NextResponse.json({ error: "mint required" }, { status: 400 });

  try {
    // Jupiter DCA public endpoint
    const r = await fetchWithTimeout(
      `https://dca-api.jup.ag/dca/positions?outputMint=${encodeURIComponent(mint)}`,
    );
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
