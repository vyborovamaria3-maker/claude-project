// data-tag: api.trade.analyze
// Full pipeline: fetch trades from Helius в†’ aggregate by wallet в†’ classify в†’ return.
import { NextRequest, NextResponse } from "next/server";
import { fetchSolBalances, getWalletFirstSeen } from "@/lib/trade/helius";
import { loadTokenTrades } from "@/lib/trade/trade-cache";
import { requireProdAuth } from "@/lib/routeAuth";
import {
  aggregateByWallet,
  calcFifoPnL,
  detectBundles,
  detectWashTrading,
  findRelatedWallets,
  isFreshWallet,
} from "@/lib/trade/classify";
import {
  getCache, setCache, getDevTag,
  recordAnalyzedMint, persistWalletSnapshots,
} from "@/lib/trade/db";

// In-memory cache for firstSeen (per-process, persists across analyses in same session).
// Wallet age doesn't change meaningfully в†’ safe to cache aggressively.
const firstSeenMemo = new Map<string, { ts: number | null; cachedAt: number }>();
const FIRST_SEEN_TTL_MS = 6 * 60 * 60 * 1000; // 6h

async function cachedFirstSeen(addr: string, getter: (a: string) => Promise<number | null>) {
  const hit = firstSeenMemo.get(addr);
  if (hit && Date.now() - hit.cachedAt < FIRST_SEEN_TTL_MS) return hit.ts;
  const ts = await getter(addr);
  firstSeenMemo.set(addr, { ts, cachedAt: Date.now() });
  return ts;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 min вЂ” full-history fetch can be slow for active tokens

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_TXS = 5000;               // ~50 pages, ~5-7s with prefetch pipeline
                                    // Covers ~90% of tokens fully; oldest trades may be missed for hyperactive ones
const FRESH_CHECK_LIMIT = 30;       // only check first-seen for top-N wallets (Helius is slow, parallelized)
const BALANCE_CHECK_LIMIT = 100;    // only fetch balances for top-N (single batched RPC call)
const ANALYSIS_SCHEMA_VERSION = 2;
const ANALYSIS_CACHE_TTL_MS = 24 * 60 * 60_000;
const RAW_TRADES_IN_RESPONSE = 2000; // cap raw trades returned to UI after full calculations
const EARLY_TRADES_IN_RESPONSE = 400;

interface WalletRow {
  address: string;
  buys: number;
  sells: number;
  volumeSol: number;
  pnlSol: number;
  pnlPercent: number;
  solBalance: number;
  tokenBalanceUsd: number;
  isFresh: boolean;
  isSmart: boolean;
  isWashTrader: boolean;
  washReasons: string[];
  bundleId?: string;
  relatedCount: number;
  firstSeen: number | null;
  freshnessVerified: boolean;
  smartClassificationAvailable: boolean;
  washConfidence: number;
  historyTruncated: boolean;
  pnlComplete: boolean;
}

function analysisCacheKey(mint: string) {
  return `v${ANALYSIS_SCHEMA_VERSION}:${mint}`;
}

function safeNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundNumber(value: unknown, decimals: number) {
  return Number(safeNumber(value).toFixed(decimals));
}

export async function GET(req: NextRequest) {
  const authError = await requireProdAuth(req);
  if (authError) return authError;

  const mint = req.nextUrl.searchParams.get("mint")?.trim();
  const skipCache = req.nextUrl.searchParams.get("refresh") === "1";

  if (!mint) return NextResponse.json({ error: "mint param required" }, { status: 400 });
  if (!MINT_RE.test(mint))
    return NextResponse.json({ error: "invalid mint format" }, { status: 400 });

  // Cache
  if (!skipCache) {
    const cached = getCache<unknown>("analysis_cache", analysisCacheKey(mint));
    if (cached) return NextResponse.json({ ...(cached as object), fromCache: true });
  }

  let trades;
  try {
    trades = await loadTokenTrades(mint, { maxTrades: MAX_TXS, refresh: skipCache });
  } catch (e) {
    return NextResponse.json(
      { error: `Trade fetch failed: ${(e as Error).message}` },
      { status: 502 }
    );
  }
  if (trades.length === 0) {
    const payload = {
      schemaVersion: ANALYSIS_SCHEMA_VERSION,
      mint,
      summary: { totalVolumeSol: 0, totalVolumeUsd: 0, totalTrades: 0, uniqueWallets: 0, historyTruncated: false },
      wallets: [],
      dev: null,
      bundles: [],
      timeline: [],
      trades: [],
      fetchedAt: Date.now(),
      note: "No trades detected for this mint",
    };
    setCache("analysis_cache", analysisCacheKey(mint), payload, ANALYSIS_CACHE_TTL_MS);
    return NextResponse.json(payload);
  }

  const walletsMap = aggregateByWallet(trades);

  // Last known price (SOL/token) вЂ” single pass, no full sort
  let currentPriceSol = 0;
  let latestTs = -Infinity;
  for (const t of trades) {
    if (t.timestamp > latestTs) {
      latestTs = t.timestamp;
      currentPriceSol = t.priceSol;
    }
  }

  // Bundle + Related detection (graph-level) вЂ” pure CPU, run sync
  const { bundles, walletBundleId } = detectBundles(trades);
  const relatedMap = findRelatedWallets(trades);

  // Top wallets by volume for expensive enrichment
  const allWallets = Array.from(walletsMap.values()).sort((a, b) => b.volumeSol - a.volumeSol);
  const topAddrs = allWallets.slice(0, BALANCE_CHECK_LIMIT).map((w) => w.address);
  const freshCheckAddrs = allWallets.slice(0, FRESH_CHECK_LIMIT).map((w) => w.address);

  // Run balance batch + per-wallet firstSeen IN PARALLEL (largest network savings)
  const firstSeenMap = new Map<string, number | null>();
  const [solBalances] = await Promise.all([
    fetchSolBalances(topAddrs),
    Promise.all(
      freshCheckAddrs.map(async (addr) => {
        firstSeenMap.set(addr, await cachedFirstSeen(addr, getWalletFirstSeen));
      })
    ),
  ]);

  const nowSec = Date.now() / 1000;

  // Build wallet rows
  const rows: WalletRow[] = allWallets.map((w) => {
    const pnl = calcFifoPnL(w.trades, currentPriceSol);
    const wash = detectWashTrading(w);
    const firstSeenGlobal = firstSeenMap.get(w.address) ?? w.firstSeen;
    return {
      address: w.address,
      buys: w.buys,
      sells: w.sells,
      volumeSol: w.volumeSol,
      pnlSol: pnl.pnlSol,
      pnlPercent: pnl.pnlPercent,
      solBalance: solBalances.get(w.address) ?? 0,
      tokenBalanceUsd: 0, // filled in Phase 3 from price oracle
      isFresh: firstSeenGlobal ? isFreshWallet(firstSeenGlobal, nowSec) : false,
      freshnessVerified: firstSeenMap.has(w.address),
      isSmart: false, // requires all-time PnL across all tokens (Phase 4)
      smartClassificationAvailable: false,
      isWashTrader: wash.isSuspicious,
      washConfidence: wash.isSuspicious ? 80 : 0,
      washReasons: wash.reasons,
      bundleId: walletBundleId.get(w.address),
      relatedCount: relatedMap.get(w.address)?.size ?? 0,
      firstSeen: firstSeenGlobal,
      historyTruncated: trades.length >= MAX_TXS,
      pnlComplete: Number.isFinite(pnl.pnlSol),
    };
  });

  // Summary
  const totalVolumeSol = trades.reduce((s, t) => s + t.amountSol, 0);
  const summary = {
    totalVolumeSol,
    totalVolumeUsd: 0, // requires SOL/USD oracle, filled in later
    totalTrades: trades.length,
    uniqueWallets: walletsMap.size,
    biggestBuy: largestTrade(trades, "buy"),
    biggestSell: largestTrade(trades, "sell"),
  };

  // Timeline (bucket by hour)
  const timeline = buildTimeline(trades);

  // DEV: creator wallet detection deferred to Phase 4
  // Could fetch creators via Helius DAS getAsset for the mint
  const devAddress: string | null = null;
  const dev = devAddress
    ? { address: devAddress, userTag: getDevTag(devAddress)?.tag ?? null }
    : null;

  // Compact raw trades after full calculations: keep the earliest sniper window plus recent action.
  // Classifiers above already used the FULL set; this just controls payload size for the UI.
  const sortedTrades = [...trades].sort((a, b) => a.timestamp - b.timestamp);
  let tradesForUi = sortedTrades;
  if (sortedTrades.length > RAW_TRADES_IN_RESPONSE) {
    const earlySnipers = sortedTrades.slice(0, EARLY_TRADES_IN_RESPONSE);
    const recent = sortedTrades.slice(-(RAW_TRADES_IN_RESPONSE - EARLY_TRADES_IN_RESPONSE));
    tradesForUi = [...earlySnipers, ...recent];
  }
  const compactTrades = tradesForUi.map((t) => ({
    ts: t.timestamp,
    w: t.trader,
    t: t.type === "buy" ? 1 : 0,
    s: roundNumber(t.amountSol, 6),
    n: roundNumber(t.amountTokens, 6),
    p: roundNumber(t.priceSol, 12),
    sig: t.signature,
    u: roundNumber((t as any).amountUsd || t.amountSol * 150, 2), // USD value (API may provide, else estimate @ $150/SOL)
  }));

  const earliest = sortedTrades[0]?.timestamp ?? null;
  const latest = sortedTrades[sortedTrades.length - 1]?.timestamp ?? null;

  const payload = {
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    mint,
    summary: {
      ...summary,
      periodStart: earliest,
      periodEnd: latest,
      totalRawTrades: trades.length,
      maxTradesRequested: MAX_TXS,
      historyTruncated: trades.length >= MAX_TXS || sortedTrades.length > RAW_TRADES_IN_RESPONSE,
    },
    wallets: rows,
    dev,
    bundles: bundles.map((b) => ({ id: b.bundleId, size: b.wallets.length, totalVolumeSol: b.totalVolumeSol, wallets: b.wallets })),
    timeline,
    trades: compactTrades,
    truncated: trades.length >= MAX_TXS || sortedTrades.length > RAW_TRADES_IN_RESPONSE,
    fetchedAt: Date.now(),
  };

  setCache("analysis_cache", analysisCacheKey(mint), payload, ANALYSIS_CACHE_TTL_MS);

  // в”Ђв”Ђ Persist to long-term DB (no TTL) в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  // Done after caching so failures here don't block the response.
  try {
    recordAnalyzedMint({
      mint,
      totalVolumeSol: summary.totalVolumeSol,
      totalTrades: summary.totalTrades,
      uniqueWallets: summary.uniqueWallets,
      devAddress,
      periodStart: earliest,
      periodEnd: latest,
    });
    persistWalletSnapshots(
      mint,
      rows.map((r) => ({
        address: r.address,
        mint,
        buys: r.buys,
        sells: r.sells,
        volumeSol: r.volumeSol,
        pnlSol: r.pnlSol,
        pnlPercent: r.pnlPercent,
        isFresh: r.isFresh,
        isWash: r.isWashTrader,
        bundleId: r.bundleId ?? null,
        firstSeen: r.firstSeen ?? null,
      }))
    );
  } catch (e) {
  }

  return NextResponse.json(payload);
}

function largestTrade(trades: { trader: string; type: string; amountSol: number }[], type: "buy" | "sell") {
  const filtered = trades.filter((t) => t.type === type);
  if (filtered.length === 0) return undefined;
  const largest = filtered.reduce((a, b) => (b.amountSol > a.amountSol ? b : a));
  return { wallet: largest.trader, amountSol: largest.amountSol };
}

function buildTimeline(trades: { timestamp: number; type: string; amountSol: number; priceSol: number }[]) {
  const buckets = new Map<number, { buyVolSol: number; sellVolSol: number; lastPrice: number }>();
  for (const t of trades) {
    const hour = Math.floor(t.timestamp / 3600) * 3600;
    let b = buckets.get(hour);
    if (!b) {
      b = { buyVolSol: 0, sellVolSol: 0, lastPrice: 0 };
      buckets.set(hour, b);
    }
    if (t.type === "buy") b.buyVolSol += t.amountSol;
    else if (t.type === "sell") b.sellVolSol += t.amountSol;
    b.lastPrice = t.priceSol;
  }
  return Array.from(buckets.entries())
    .map(([ts, v]) => ({ ts, buyVolSol: v.buyVolSol, sellVolSol: v.sellVolSol, price: v.lastPrice }))
    .sort((a, b) => a.ts - b.ts);
}
