// data-tag: api.trade.chart-markers
// Returns historical DEV-creator and bundle trades for chart annotations.
// Reads from analysis_cache if available — otherwise returns empty (frontend
// can rely on live WS stream to populate as new trades arrive).
import { NextRequest, NextResponse } from "next/server";
import { getCache } from "@/lib/trade/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CompactTrade {
  ts: number;     // unix sec
  w: string;      // wallet
  t: 0 | 1;       // 1 = buy, 0 = sell
  s: number;      // SOL amount
  u?: number;     // USD amount
}

interface CachedAnalysis {
  mint: string;
  dev?: { address: string } | null;
  bundles?: { id: string; wallets: string[] }[];
  trades?: CompactTrade[];
}

export async function GET(req: NextRequest) {
  const mint = req.nextUrl.searchParams.get("mint")?.trim();
  if (!mint) return NextResponse.json({ error: "mint required" }, { status: 400 });

  const cached = getCache<CachedAnalysis>("analysis_cache", mint);
  if (!cached || !cached.trades) {
    return NextResponse.json({
      mint,
      cached: false,
      creatorAddress: null,
      devTrades: [],
      bundleTrades: [],
    });
  }

  const creator = cached.dev?.address || null;
  const bundleWallets = new Set<string>();
  for (const b of cached.bundles || []) {
    for (const w of b.wallets) bundleWallets.add(w);
  }
  // Map wallet → bundleId for tooltip context
  const walletToBundle = new Map<string, string>();
  for (const b of cached.bundles || []) {
    for (const w of b.wallets) walletToBundle.set(w, b.id);
  }

  const devTrades: CompactTrade[] = [];
  const bundleTrades: (CompactTrade & { bundleId: string })[] = [];

  for (const t of cached.trades) {
    if (creator && t.w === creator) devTrades.push(t);
    if (bundleWallets.has(t.w)) {
      const bundleId = walletToBundle.get(t.w) || "?";
      bundleTrades.push({ ...t, bundleId });
    }
  }

  return NextResponse.json({
    mint,
    cached: true,
    creatorAddress: creator,
    devTrades,
    bundleTrades,
  });
}
