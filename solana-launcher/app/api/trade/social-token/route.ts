import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { fetchBackendSocial, passthroughJson } from "@/lib/trade/backend-social-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_QUERY = new Set([
  "platform",
  "hours",
  "sources",
  "explicit_calls_only",
  "min_engagement",
  "min_channel_score",
  "limit",
]);

function validMint(value: string): boolean {
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  const mint = request.nextUrl.searchParams.get("mint")?.trim() || "";
  if (!validMint(mint)) {
    return NextResponse.json({ error: "invalid Solana mint" }, { status: 400 });
  }

  const query = new URLSearchParams();
  for (const [key, value] of request.nextUrl.searchParams) {
    if (key !== "mint" && ALLOWED_QUERY.has(key)) query.append(key, value);
  }

  const upstream = await fetchBackendSocial(
    request,
    `/api/v1/social/token/${encodeURIComponent(mint)}`,
    query,
  );
  return passthroughJson(upstream);
}
