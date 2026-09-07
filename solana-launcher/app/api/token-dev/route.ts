import { NextRequest, NextResponse } from "next/server";
import { requireProdAuth } from "@/lib/routeAuth";

// data-tag: api.token_dev
// Other tokens created by the same creator/dev wallet via Helius DAS getAssetsByCreator

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HELIUS_URL =
  process.env.HELIUS_RPC_URL ||
  process.env.NEXT_PUBLIC_HELIUS_RPC_URL ||
  process.env.RPC_URL ||
  process.env.NEXT_PUBLIC_RPC_URL ||
  "https://api.mainnet-beta.solana.com";
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const r = await fetch(HELIUS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!r.ok) throw new Error("rpc_unavailable");
  const data = await r.json();
  if (data.error) throw new Error("rpc_error");
  return data.result as T;
}

export async function GET(req: NextRequest) {
  const authError = await requireProdAuth(req);
  if (authError) return authError;

  const mint = req.nextUrl.searchParams.get("mint")?.trim() || "";
  const creator = req.nextUrl.searchParams.get("creator")?.trim() || "";
  if (!mint && !creator) {
    return NextResponse.json({ error: "mint or creator required" }, { status: 400 });
  }
  if ((mint && !SOLANA_ADDRESS_RE.test(mint)) || (creator && !SOLANA_ADDRESS_RE.test(creator))) {
    return NextResponse.json({ error: "invalid Solana address" }, { status: 400 });
  }

  try {
    let creatorAddr = creator || null;

    // Find creator from mint if not provided
    if (!creatorAddr && mint) {
      try {
        const asset = await rpc<{ creators?: { address: string }[]; authorities?: { address: string }[] }>(
          "getAsset",
          { id: mint },
        );
        const discovered = asset.creators?.[0]?.address || asset.authorities?.[0]?.address || null;
        creatorAddr = discovered && SOLANA_ADDRESS_RE.test(discovered) ? discovered : null;
      } catch {
        creatorAddr = null;
      }
    }

    if (!creatorAddr) {
      return NextResponse.json(
        { creator: null, tokens: [] },
        { headers: { "Cache-Control": "private, no-store, max-age=0" } },
      );
    }

    // Get all assets by this creator
    const assets = await rpc<{
      items: {
        id: string;
        content?: {
          metadata?: { name?: string; symbol?: string };
          links?: { image?: string };
        };
        token_info?: { supply?: number; decimals?: number };
      }[];
    }>(
      "getAssetsByCreator",
      { creatorAddress: creatorAddr, page: 1, limit: 50, onlyVerified: false },
    );

    const tokens = (assets.items ?? [])
      .filter((asset) => asset.id !== mint)
      .map((asset) => ({
        mint: asset.id,
        name: asset.content?.metadata?.name ?? "",
        symbol: asset.content?.metadata?.symbol ?? "",
        image: asset.content?.links?.image ?? "",
        supply: asset.token_info?.supply ?? 0,
      }));

    return NextResponse.json(
      { creator: creatorAddr, tokens },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch {
    return NextResponse.json({ error: "rpc_unavailable", tokens: [] }, { status: 502 });
  }
}
