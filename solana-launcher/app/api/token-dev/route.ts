import { NextRequest, NextResponse } from "next/server";

// data-tag: api.token_dev
// Other tokens created by the same creator/dev wallet via Helius DAS getAssetsByCreator

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HELIUS_URL =
  process.env.NEXT_PUBLIC_HELIUS_RPC_URL ||
  process.env.NEXT_PUBLIC_RPC_URL ||
  "https://api.mainnet-beta.solana.com";

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const r = await fetch(HELIUS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cache: "no-store",
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  return data.result as T;
}

export async function GET(req: NextRequest) {
  const mint = req.nextUrl.searchParams.get("mint");
  const creator = req.nextUrl.searchParams.get("creator");
  if (!mint && !creator) {
    return NextResponse.json({ error: "mint or creator required" }, { status: 400 });
  }

  try {
    let creatorAddr = creator;

    // Find creator from mint if not provided
    if (!creatorAddr && mint) {
      try {
        const asset = await rpc<{ creators?: { address: string }[]; authorities?: { address: string }[] }>(
          "getAsset",
          { id: mint }
        );
        creatorAddr = asset.creators?.[0]?.address || asset.authorities?.[0]?.address || null;
      } catch {
        creatorAddr = null;
      }
    }

    if (!creatorAddr) {
      return NextResponse.json({ creator: null, tokens: [] });
    }

    // Get all assets by this creator
    const assets = await rpc<{ items: { id: string; content?: { metadata?: { name?: string; symbol?: string }; links?: { image?: string } }; token_info?: { supply?: number; decimals?: number } }[] }>(
      "getAssetsByCreator",
      { creatorAddress: creatorAddr, page: 1, limit: 50, onlyVerified: false }
    );

    const tokens = (assets.items ?? [])
      .filter(a => a.id !== mint)
      .map(a => ({
        mint: a.id,
        name: a.content?.metadata?.name ?? "",
        symbol: a.content?.metadata?.symbol ?? "",
        image: a.content?.links?.image ?? "",
        supply: a.token_info?.supply ?? 0,
      }));

    return NextResponse.json({ creator: creatorAddr, tokens });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "fetch_failed";
    return NextResponse.json({ error: msg, tokens: [] }, { status: 500 });
  }
}
