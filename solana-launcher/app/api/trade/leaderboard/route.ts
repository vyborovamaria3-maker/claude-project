// data-tag: api.trade.leaderboard
// Top traders (by PnL/volume) and top devs (by tokens/migration rate).
import { NextRequest, NextResponse } from "next/server";
import { listTopWallets, listTopDevWallets } from "@/lib/trade/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const kind = searchParams.get("kind") || "wallets";
  const orderBy = searchParams.get("orderBy") || "pnl";
  const parsedLimit = Number(searchParams.get("limit") || 50);
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(Math.trunc(parsedLimit), 200)) : 50;

  if (kind === "devs") {
    const order = (["tokens", "migration", "300k"].includes(orderBy) ? orderBy : "tokens") as
      | "tokens" | "migration" | "300k";
    return NextResponse.json({ kind: "devs", orderBy: order, items: listTopDevWallets(order, limit) });
  }

  const order = (orderBy === "volume" ? "volume" : "pnl") as "pnl" | "volume";
  return NextResponse.json({ kind: "wallets", orderBy: order, items: listTopWallets(order, limit) });
}
