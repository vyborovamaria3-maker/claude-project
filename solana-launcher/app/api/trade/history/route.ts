// data-tag: api.trade.history
// Returns persistent history of analyzed mints + top wallets aggregated across all analyses.
import { NextRequest, NextResponse } from "next/server";
import {
  listAnalyzedMints,
  listTopWallets,
  getWalletStats,
  getWalletTokens,
} from "@/lib/trade/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const kind = sp.get("kind") ?? "mints"; // mints | wallets | wallet
  const parsedLimit = Number(sp.get("limit") ?? 100);
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(Math.trunc(parsedLimit), 500)) : 100;

  if (kind === "mints") {
    return NextResponse.json({ mints: listAnalyzedMints(limit) });
  }

  if (kind === "wallets") {
    const orderBy = (sp.get("order") === "volume" ? "volume" : "pnl") as "pnl" | "volume";
    return NextResponse.json({ wallets: listTopWallets(orderBy, limit) });
  }

  if (kind === "wallet") {
    const address = sp.get("address")?.trim();
    if (!address) return NextResponse.json({ error: "address required" }, { status: 400 });
    const stats = getWalletStats(address);
    const tokens = getWalletTokens(address);
    return NextResponse.json({ stats, tokens });
  }

  return NextResponse.json({ error: "unknown kind" }, { status: 400 });
}
