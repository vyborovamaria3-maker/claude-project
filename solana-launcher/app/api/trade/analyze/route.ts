// data-tag: api.trade.analyze
// Full pipeline: fetch trades from Helius -> aggregate by wallet -> classify -> return.
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
  getCache,
  setCache,
  getDevTag,
  recordAnalyzedMint,
  persistWalletSnapshots,
} from "@/lib/trade/db";

const firstSeenMemo = new Map<string, { ts: number | null; cachedAt: number }>();
const FIRST_SEEN_TTL_MS = 6 * 60 * 60 * 1000;

async function cachedFirstSeen(addr: string, getter: (a: string) => Promise<number | null>) {
  const hit = firstSeenMemo.get(addr);
  if (hit && Date.now() - hit.cachedAt < FIRST_SEEN_TTL_MS) return hit.ts;
  const ts = await getter(addr);
  firstSeenMemo.set(addr, { ts, cachedAt: Date.now() });
  return ts;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_TXS = 5000;
const FRESH_CHECK_LIMIT = 30;
const BALANCE_CHECK_LIMIT = 100;
const ANALYSIS_SCHEMA_VERSION = 3;
const ANALYSIS_CACHE_TTL_MS = 24 * 60 * 60_000;
const RAW_TRADES_IN_RESPONSE = 2000;
const EARLY_TRADES_IN_RESPONSE = 400;

interface WalletRow {
  address: string;
  buys: number;
  sells: number;
  volumeSol: number;
  pnlSol: number;
  pnlPercent: number;
  solBalance: number | null;
  balanceVerified: boolean;
  tokenBalanceUsd: number | null;
  isFresh: boolean | null;
  isSmart: boolean;
  isWashTrader: boolean;
  washReasons: string[];
  bundleId?: string;
  relatedCount: number;
  firstSeen: number | null;
  firstSeenOnToken: number | null;
  freshnessVerified: boolean;
  smartClassificationAvailable: boolean;
  washConfidence: number;
  historyTruncated: boolean;
  pnlComplete: boolean;
}

function analysisCacheKey(mint: string) {
  return `v${ANALYSIS_SCHEMA_VERSION}:${mint}`;
}

function roundNumber(value: unknown, decimals: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(decimals)) : 0;
}

export async function GET(req: NextRequest) {
  const authError = await requireProdAuth(req);
  if (authError) return authError;

  const mint = req.nextUrl.searchParams.get("mint")?.trim();
  const skipCache = req.nextUrl.searchParams.get("refresh") === "1";

  if (!mint) return NextResponse.json({ error: "mint param required" }, { status: 400 });
  if (!MINT_RE.test(mint)) {
    return NextResponse.json({ error: "invalid mint format" }, { status: 400 });
  }

  if (!skipCache) {
    const cached = getCache<unknown>("analysis_cache", analysisCacheKey(mint));
    if (cached) return NextResponse.json({ ...(cached as object), fromCache: true });
  }

  let trades;
  try {
    trades = await loadTokenTrades(mint, { maxTrades: MAX_TXS, refresh: skipCache });
  } catch (error) {
    return NextResponse.json(
      { error: `Trade fetch failed: ${error instanceof Error ? error.message : String(error)}` },
      { status: 502 },
    );
  }

  if (trades.length === 0) {
    const payload = {
      schemaVersion: ANALYSIS_SCHEMA_VERSION,
      mint,
      summary: {
        totalVolumeSol: 0,
        totalVolumeUsd: null,
        totalTrades: 0,
        totalRawTrades: 0,
        uniqueWallets: 0,
        historyTruncated: false,
        responseTradesTruncated: false,
        maxTradesRequested: MAX_TXS,
      },
      wallets: [],
      dev: null,
      bundles: [],
      timeline: [],
      trades: [],
      truncated: false,
      fetchedAt: Date.now(),
      note: "No trades detected for this mint",
    };
    setCache("analysis_cache", analysisCacheKey(mint), payload, ANALYSIS_CACHE_TTL_MS);
    return NextResponse.json(payload);
  }

  const historyTruncated = trades.length >= MAX_TXS;
  const walletsMap = aggregateByWallet(trades);

  let currentPriceSol = 0;
  let latestTs = -Infinity;
  for (const trade of trades) {
    if (trade.timestamp > latestTs) {
      latestTs = trade.timestamp;
      currentPriceSol = trade.priceSol;
    }
  }

  const { bundles, walletBundleId } = detectBundles(trades);
  const relatedMap = findRelatedWallets(trades);
  const allWallets = Array.from(walletsMap.values()).sort((left, right) => right.volumeSol - left.volumeSol);
  const topAddrs = allWallets.slice(0, BALANCE_CHECK_LIMIT).map((wallet) => wallet.address);
  const freshCheckAddrs = allWallets.slice(0, FRESH_CHECK_LIMIT).map((wallet) => wallet.address);

  const firstSeenMap = new Map<string, number | null>();
  const [solBalances] = await Promise.all([
    fetchSolBalances(topAddrs),
    Promise.all(
      freshCheckAddrs.map(async (address) => {
        firstSeenMap.set(address, await cachedFirstSeen(address, getWalletFirstSeen));
      }),
    ),
  ]);

  const nowSec = Date.now() / 1000;
  const rows: WalletRow[] = allWallets.map((wallet, index) => {
    const pnl = calcFifoPnL(wallet.trades, currentPriceSol);
    const wash = detectWashTrading(wallet);
    const globalFirstSeen = firstSeenMap.get(wallet.address);
    const freshnessVerified = index < FRESH_CHECK_LIMIT && globalFirstSeen != null;
    const pnlComplete = !historyTruncated
      && wallet.totalTokensSold <= wallet.totalTokensBought + 1e-9;

    return {
      address: wallet.address,
      buys: wallet.buys,
      sells: wallet.sells,
      volumeSol: wallet.volumeSol,
      pnlSol: pnl.pnlSol,
      pnlPercent: pnl.pnlPercent,
      solBalance: solBalances.get(wallet.address) ?? null,
      balanceVerified: index < BALANCE_CHECK_LIMIT && solBalances.has(wallet.address),
      tokenBalanceUsd: null,
      isFresh: freshnessVerified && globalFirstSeen != null
        ? isFreshWallet(globalFirstSeen, nowSec)
        : null,
      freshnessVerified,
      isSmart: false,
      smartClassificationAvailable: false,
      isWashTrader: wash.isSuspicious,
      washConfidence: wash.confidence,
      washReasons: wash.reasons,
      bundleId: walletBundleId.get(wallet.address),
      relatedCount: relatedMap.get(wallet.address)?.size ?? 0,
      firstSeen: freshnessVerified ? globalFirstSeen ?? null : null,
      firstSeenOnToken: wallet.firstSeen,
      historyTruncated,
      pnlComplete,
    };
  });

  const totalVolumeSol = trades.reduce((sum, trade) => sum + trade.amountSol, 0);
  const summary = {
    totalVolumeSol,
    // RawTrade is SOL-denominated. Keep USD unknown until a real SOL/USD oracle is joined.
    totalVolumeUsd: null,
    totalTrades: trades.length,
    uniqueWallets: walletsMap.size,
    biggestBuy: largestTrade(trades, "buy"),
    biggestSell: largestTrade(trades, "sell"),
  };

  const timeline = buildTimeline(trades);
  const devAddress: string | null = null;
  const dev = devAddress
    ? { address: devAddress, userTag: getDevTag(devAddress)?.tag ?? null }
    : null;

  const sortedTrades = [...trades].sort((left, right) => left.timestamp - right.timestamp);
  const responseTradesTruncated = sortedTrades.length > RAW_TRADES_IN_RESPONSE;
  let tradesForUi = sortedTrades;
  if (responseTradesTruncated) {
    const earlySnipers = sortedTrades.slice(0, EARLY_TRADES_IN_RESPONSE);
    const recent = sortedTrades.slice(-(RAW_TRADES_IN_RESPONSE - EARLY_TRADES_IN_RESPONSE));
    tradesForUi = [...earlySnipers, ...recent];
  }

  const compactTrades = tradesForUi.map((trade) => ({
    ts: trade.timestamp,
    w: trade.trader,
    t: trade.type === "buy" ? 1 : 0,
    s: roundNumber(trade.amountSol, 6),
    n: roundNumber(trade.amountTokens, 6),
    p: roundNumber(trade.priceSol, 12),
    sig: trade.signature,
    // Do not fabricate USD from a fixed SOL price. No USD oracle exists in this pipeline.
    u: null,
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
      historyTruncated,
      responseTradesTruncated,
    },
    wallets: rows,
    dev,
    bundles: bundles.map((bundle) => ({
      id: bundle.bundleId,
      size: bundle.wallets.length,
      totalVolumeSol: bundle.totalVolumeSol,
      wallets: bundle.wallets,
    })),
    timeline,
    trades: compactTrades,
    truncated: historyTruncated || responseTradesTruncated,
    fetchedAt: Date.now(),
  };

  setCache("analysis_cache", analysisCacheKey(mint), payload, ANALYSIS_CACHE_TTL_MS);

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
      rows.map((row) => ({
        address: row.address,
        mint,
        buys: row.buys,
        sells: row.sells,
        volumeSol: row.volumeSol,
        pnlSol: row.pnlSol,
        pnlPercent: row.pnlPercent,
        isFresh: row.isFresh === true,
        isWash: row.isWashTrader,
        bundleId: row.bundleId ?? null,
        firstSeen: row.firstSeen ?? null,
      })),
    );
  } catch {
    // Persistence is non-blocking for analysis delivery.
  }

  return NextResponse.json(payload);
}

function largestTrade(
  trades: { trader: string; type: string; amountSol: number }[],
  type: "buy" | "sell",
) {
  const filtered = trades.filter((trade) => trade.type === type);
  if (filtered.length === 0) return undefined;
  const largest = filtered.reduce((left, right) => right.amountSol > left.amountSol ? right : left);
  return { wallet: largest.trader, amountSol: largest.amountSol };
}

function buildTimeline(
  trades: { timestamp: number; type: string; amountSol: number; priceSol: number }[],
) {
  const buckets = new Map<number, { buyVolSol: number; sellVolSol: number; lastPrice: number }>();
  for (const trade of trades) {
    const hour = Math.floor(trade.timestamp / 3600) * 3600;
    let bucket = buckets.get(hour);
    if (!bucket) {
      bucket = { buyVolSol: 0, sellVolSol: 0, lastPrice: 0 };
      buckets.set(hour, bucket);
    }
    if (trade.type === "buy") bucket.buyVolSol += trade.amountSol;
    else if (trade.type === "sell") bucket.sellVolSol += trade.amountSol;
    bucket.lastPrice = trade.priceSol;
  }
  return Array.from(buckets.entries())
    .map(([ts, value]) => ({
      ts,
      buyVolSol: value.buyVolSol,
      sellVolSol: value.sellVolSol,
      price: value.lastPrice,
    }))
    .sort((left, right) => left.ts - right.ts);
}
