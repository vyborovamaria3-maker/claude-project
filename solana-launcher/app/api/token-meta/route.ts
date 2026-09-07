import { NextRequest, NextResponse } from "next/server";

const UPSTREAM_TIMEOUT_MS = 5_000;

async function fetchJson(url: string, init?: RequestInit): Promise<{ ok: boolean; data: any }> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  const data = await response.json();
  return { ok: response.ok, data };
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const mint = searchParams.get("mint")?.trim() || "";
  if (!mint) return NextResponse.json({ error: "mint required" }, { status: 400 });
  const encodedMint = encodeURIComponent(mint);

  try {
    // Try DexScreener first
    const dex = await fetchJson(
      `https://api.dexscreener.com/latest/dex/tokens/${encodedMint}`,
      { next: { revalidate: 30 } },
    );
    const dexData = dex.data;
    const mintLower = mint.toLowerCase();
    const pair = (dexData?.pairs ?? []).find(
      (p: any) => p?.baseToken?.address?.toLowerCase?.() === mintLower,
    );

    if (dex.ok && pair) {
      const info = pair.info ?? {};
      const token = pair.baseToken ?? {};
      return NextResponse.json({
        name: token.name ?? null,
        symbol: token.symbol ?? null,
        image: info.imageUrl ?? null,
        marketCap: pair.marketCap ?? null,
        website: info.websites?.[0]?.url ?? null,
        twitter: info.socials?.find((s: any) => s.type === "twitter")?.url ?? null,
        telegram: info.socials?.find((s: any) => s.type === "telegram")?.url ?? null,
        dexUrl: `https://dexscreener.com/solana/${encodedMint}`,
        pumpUrl: `https://pump.fun/${encodedMint}`,
        verified: true,
      });
    }

    // Fallback: Pump.fun API
    const pump = await fetchJson(`https://frontend-api.pump.fun/coins/${encodedMint}`, {
      cache: "no-store",
    });
    if (pump.ok) {
      const p = pump.data;
      return NextResponse.json({
        name: p.name ?? null,
        symbol: p.symbol ?? null,
        image: p.image_uri ?? null,
        marketCap: p.usd_market_cap ?? null,
        website: p.website ?? null,
        twitter: p.twitter ? `https://twitter.com/${String(p.twitter).replace(/^@/, "")}` : null,
        telegram: p.telegram ?? null,
        dexUrl: `https://dexscreener.com/solana/${encodedMint}`,
        pumpUrl: `https://pump.fun/${encodedMint}`,
        verified: false,
      });
    }

    return NextResponse.json({ error: "Token not found" }, { status: 404 });
  } catch {
    return NextResponse.json({ error: "token_metadata_unavailable" }, { status: 502 });
  }
}
