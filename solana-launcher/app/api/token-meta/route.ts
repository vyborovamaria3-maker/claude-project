import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const mint = searchParams.get("mint");
  if (!mint) return NextResponse.json({ error: "mint required" }, { status: 400 });

  try {
    // Try DexScreener first
    const dexRes = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { next: { revalidate: 30 } }
    );
    const dexData = await dexRes.json();
    const mintLower = mint.toLowerCase();
    const pair = (dexData?.pairs ?? []).find(
      (p: any) => p?.baseToken?.address?.toLowerCase?.() === mintLower
    );

    if (pair) {
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
        dexUrl: `https://dexscreener.com/solana/${mint}`,
        pumpUrl: `https://pump.fun/${mint}`,
        verified: true,
      });
    }

    // Fallback: Pump.fun API
    const pumpRes = await fetch(`https://frontend-api.pump.fun/coins/${mint}`);
    if (pumpRes.ok) {
      const p = await pumpRes.json();
      return NextResponse.json({
        name: p.name ?? null,
        symbol: p.symbol ?? null,
        image: p.image_uri ?? null,
        marketCap: p.usd_market_cap ?? null,
        website: p.website ?? null,
        twitter: p.twitter ? `https://twitter.com/${p.twitter.replace(/^@/, "")}` : null,
        telegram: p.telegram ?? null,
        dexUrl: `https://dexscreener.com/solana/${mint}`,
        pumpUrl: `https://pump.fun/${mint}`,
        verified: false,
      });
    }

    return NextResponse.json({ error: "Token not found" }, { status: 404 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
