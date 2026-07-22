// data-tag: api.trade.dev-wallet
// Fast lookup of persisted creator wallet data from SQLite.
// GET /api/trade/dev-wallet?address=<creator>
// GET /api/trade/dev-wallet?mint=<tokenMint>         (resolve creator from persisted token data)
// GET /api/trade/dev-wallet?address=<creator>&tokens=1  (include token list)
// GET /api/trade/dev-wallet?top=tokens|migration|300k   (leaderboard, no address required)
import { NextRequest, NextResponse } from "next/server";
import { getDevWallet, getDevTokensByCreator, getPersistedCreatorForMint, listTopDevWallets } from "@/lib/trade/db";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const mint = searchParams.get("mint");
  let address = searchParams.get("address");
  const top = searchParams.get("top") as "tokens" | "migration" | "300k" | null;
  const includeTokens = searchParams.get("tokens") === "1";
  const limit = Math.min(Number(searchParams.get("limit") ?? 100), 1000);

  // ── Leaderboard mode ──────────────────────────────────────────
  if (top) {
    const rows = listTopDevWallets(top, limit);
    return NextResponse.json({ rows });
  }

  // ── Single wallet lookup ──────────────────────────────────────
  if (!address) {
    if (mint) {
      address = getPersistedCreatorForMint(mint);
    }
  }

  if (!address) {
    return NextResponse.json({ error: "address, mint or top param required" }, { status: 400 });
  }

  const tokens = getDevTokensByCreator(address, limit);
  let wallet = getDevWallet(address);

  if (!wallet && tokens.length > 0) {
    const migratedCount = tokens.filter((token) => token.isMigrated).length;
    const reached300kCount = tokens.filter((token) => token.reached300k).length;
    const mcValues = tokens
      .map((token) => Math.max(token.marketCapUsd ?? 0, token.athUsd ?? 0))
      .filter((value) => value > 0);

    wallet = {
      address,
      totalTokens: tokens.length,
      migratedCount,
      migrationRate: tokens.length > 0 ? migratedCount / tokens.length : 0,
      reached300kCount,
      rate300k: tokens.length > 0 ? reached300kCount / tokens.length : 0,
      bestLaunchHour: null,
      totalVolumeSol: 0,
      totalFeesSol: 0,
      avgMcUsd: mcValues.length > 0 ? mcValues.reduce((sum, value) => sum + value, 0) / mcValues.length : null,
      maxMcUsd: mcValues.length > 0 ? Math.max(...mcValues) : null,
      source: "derived",
      firstSeenAt: tokens.reduce((min, token) => {
        const createdAtMs = token.createdAt ? token.createdAt * 1000 : null;
        return createdAtMs && createdAtMs < min ? createdAtMs : min;
      }, Date.now()),
      lastUpdatedAt: Date.now(),
    };
  }

  if (!wallet) {
    return NextResponse.json({ found: false, address, mint: mint ?? null }, { status: 404 });
  }

  return NextResponse.json({ found: true, wallet, tokens: includeTokens ? tokens : undefined, address, sourceMint: mint ?? null });
}
