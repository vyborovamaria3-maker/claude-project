import { tradeQuoteAmount, tradeQuoteMint, WRAPPED_SOL_MINT } from "./types";
import type { FundingEdge, HolderAccount, HolderSnapshot, RawTrade, WalletTokenHistory } from "./types";

/** V3.4 pure analytics. No I/O, no cache mutation, no network calls. */

const EPS = 1e-9;
const FLOW_MIN_COVERAGE = 0.95;
const WHALE_THRESHOLD_SOL = 10;
const FUNDING_BURST_THRESHOLD_MS = 60_000;
const WASH_WINDOW_SLOTS = 100;
const WASH_PAIR_THRESHOLD = 3;
const WASH_LOOKBACK_SEC = 3_600;
const VERIFIED_FUNDING_CONFIDENCE = 0.8;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const clamp = (value: number, min = 0, max = 1): number => Math.max(min, Math.min(max, value));
const finiteOrNull = (value: number | null | undefined): number | null => finite(value) ? value : null;

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  const value = values.reduce((sum, item) => sum + item, 0) / values.length;
  return finite(value) ? value : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return finite(value) ? value : null;
}

function std(values: number[]): number | null {
  if (values.length < 2) return null;
  const avg = mean(values);
  if (avg == null) return null;
  const variance = values.reduce((sum, item) => sum + (item - avg) ** 2, 0) / (values.length - 1);
  const value = Math.sqrt(Math.max(0, variance));
  return finite(value) ? value : null;
}

function entropy(values: number[]): number | null {
  const positive = values.filter((value) => finite(value) && value > 0);
  const total = positive.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) return null;
  const result = positive.reduce((sum, value) => {
    const p = value / total;
    return sum - p * Math.log2(p);
  }, 0);
  return finite(result) ? result : null;
}

function gini(values: number[]): number | null {
  const xs = values.filter((value) => finite(value) && value >= 0).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const total = xs.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) return null;
  let weighted = 0;
  for (let i = 0; i < xs.length; i++) weighted += (i + 1) * xs[i];
  const result = (2 * weighted) / (xs.length * total) - (xs.length + 1) / xs.length;
  return finite(result) ? clamp(result) : null;
}

function pctScale(holders: HolderAccount[]): "share01" | "percent100" {
  const values = holders.map((holder) => holder.pct).filter(finite);
  if (values.length === 0) return "percent100";
  const max = Math.max(...values);
  const sum = values.reduce((acc, value) => acc + Math.max(0, value), 0);
  return max > 1 + EPS || sum > 1.5 ? "percent100" : "share01";
}

function share01(value: number, scale: "share01" | "percent100"): number {
  return clamp(scale === "percent100" ? value / 100 : value);
}

function topShare01(holders: HolderAccount[], count: number, scale = pctScale(holders)): number | null {
  if (holders.length === 0) return null;
  const values = holders
    .map((holder) => finite(holder.pct) ? share01(holder.pct, scale) : null)
    .filter((value): value is number => value != null)
    .sort((a, b) => b - a)
    .slice(0, count);
  return values.length > 0 ? clamp(values.reduce((sum, value) => sum + value, 0)) : null;
}

function isSolNotionalTrade(trade: RawTrade): boolean {
  return tradeQuoteMint(trade) === WRAPPED_SOL_MINT && finite(trade.amountSol) && Math.abs(trade.amountSol) > 0;
}

function tradePriceQuote(trade: RawTrade): number | null {
  if (!(finite(trade.amountTokens) && trade.amountTokens > 0)) return null;
  const quote = tradeQuoteAmount(trade);
  return finite(quote) && Math.abs(quote) > 0 ? Math.abs(quote) / trade.amountTokens : null;
}

function sortedTrades(trades: RawTrade[]): RawTrade[] {
  return [...trades].sort((a, b) => {
    const slotA = finite(a.slot) ? a.slot : Number.MAX_SAFE_INTEGER;
    const slotB = finite(b.slot) ? b.slot : Number.MAX_SAFE_INTEGER;
    if (slotA !== slotB) return slotA - slotB;
    return a.timestamp - b.timestamp;
  });
}

function comparableWindowNotionals(trades: RawTrade[]): {
  unit: "usd" | "sol" | "quote";
  quoteMint: string | null;
  rows: Array<{ trade: RawTrade; amount: number }>;
} | null {
  if (trades.length === 0) return null;

  // Never mix USD and native quote units inside one OFI/volume calculation. If every
  // row has a USD notional, USD is safe. Otherwise fall back to a single common quote
  // mint and recompute every row in that quote asset, even when only some rows also
  // carry quoteUsdValue.
  if (trades.every((trade) => finite(trade.quoteUsdValue))) {
    return {
      unit: "usd",
      quoteMint: null,
      rows: trades.map((trade) => ({ trade, amount: Math.abs(trade.quoteUsdValue!) })),
    };
  }

  const mints = new Set(trades.map(tradeQuoteMint));
  if (mints.size !== 1) return null;
  const quoteMint = [...mints][0];
  if (quoteMint === "unknown") return null;
  const amounts = trades.map((trade) => tradeQuoteAmount(trade));
  if (!amounts.every((amount) => finite(amount))) return null;
  return {
    unit: quoteMint === WRAPPED_SOL_MINT ? "sol" : "quote",
    quoteMint,
    rows: trades.map((trade, index) => ({ trade, amount: Math.abs(amounts[index]) })),
  };
}

function windowCoverage(
  trades: RawTrade[],
  windowSec: number,
  explicitCoverageSec: number | null | undefined,
  historyComplete = false,
): number {
  if (historyComplete) return 1;
  if (finite(explicitCoverageSec) && explicitCoverageSec >= 0) return clamp(explicitCoverageSec / windowSec);
  const timestamps = trades.map((trade) => trade.timestamp).filter(finite);
  if (timestamps.length < 2) return 0;
  return clamp((Math.max(...timestamps) - Math.min(...timestamps)) / windowSec);
}

// ─────────────────────────────────────────────────────────────
// 1. Wallet Performance
// ─────────────────────────────────────────────────────────────

export interface WalletPerformance {
  wallet: string;
  winRate: number | null;
  medianHoldSlots: number | null;
  realizedPnlSol: number | null;
  unrealizedPnlSol: number | null;
  realizedRatio: number | null;
  tradeCount: number;
  avgTradeSizeSol: number | null;
  avgTradeSizeQuote: number | null;
  quoteMint: string | null;
  isSmartMoney: boolean | null;
  historySampleSize: number;
}

function fifoHoldSlots(trades: RawTrade[]): number[] {
  const lots: Array<{ slot: number; amount: number }> = [];
  const holds: number[] = [];
  for (const trade of sortedTrades(trades)) {
    if (!finite(trade.slot) || !finite(trade.amountTokens) || !(trade.amountTokens > 0)) continue;
    if (trade.type === "buy") {
      lots.push({ slot: trade.slot, amount: trade.amountTokens });
      continue;
    }
    if (trade.type !== "sell") continue;
    let remaining = trade.amountTokens;
    while (remaining > EPS && lots.length > 0) {
      const lot = lots[0];
      const matched = Math.min(remaining, lot.amount);
      if (trade.slot >= lot.slot && matched > 0) holds.push(trade.slot - lot.slot);
      remaining -= matched;
      lot.amount -= matched;
      if (lot.amount <= EPS) lots.shift();
    }
  }
  return holds;
}

export function computeWalletPerformance(
  wallet: string,
  walletTokens: WalletTokenHistory[],
  walletTrades: RawTrade[],
): WalletPerformance {
  const pnlRows = walletTokens.filter((row) => finite(row.pnlSol));
  const wins = pnlRows.filter((row) => row.pnlSol > 0).length;
  const winRate = pnlRows.length > 0 ? clamp(wins / pnlRows.length) : null;

  const explicitRealized = walletTokens.map((row) => row.realizedPnlSol).filter(finite);
  const explicitUnrealized = walletTokens.map((row) => row.unrealizedPnlSol).filter(finite);
  const realizedPnlSol = explicitRealized.length === walletTokens.length && walletTokens.length > 0
    ? explicitRealized.reduce((sum, value) => sum + value, 0)
    : null;
  const unrealizedPnlSol = explicitUnrealized.length === walletTokens.length && walletTokens.length > 0
    ? explicitUnrealized.reduce((sum, value) => sum + value, 0)
    : null;
  const totalPnl = realizedPnlSol != null && unrealizedPnlSol != null ? realizedPnlSol + unrealizedPnlSol : null;
  const realizedRatio = totalPnl != null && totalPnl > 0
    ? clamp(realizedPnlSol! / totalPnl)
    : null;

  const explicitHolds = walletTokens.map((row) => row.medianHoldSlots).filter(finite);
  const derivedHolds = fifoHoldSlots(walletTrades);
  const medianHoldSlots = explicitHolds.length > 0 ? median(explicitHolds) : median(derivedHolds);

  const priorTrades = walletTokens.reduce((sum, row) => {
    if (finite(row.tradeCount) && row.tradeCount! >= 0) return sum + row.tradeCount!;
    return sum + Math.max(0, row.buys) + Math.max(0, row.sells);
  }, 0);
  const tradeCount = Math.max(walletTrades.length, priorTrades);

  const solSizes = walletTrades
    .filter(isSolNotionalTrade)
    .map((trade) => Math.abs(trade.amountSol))
    .filter((value) => finite(value) && value > 0);
  const avgTradeSizeSol = mean(solSizes);

  const quoteRows = walletTrades
    .map((trade) => ({ mint: tradeQuoteMint(trade), amount: tradeQuoteAmount(trade) }))
    .filter((row): row is { mint: string; amount: number } =>
      typeof row.mint === "string" && row.mint !== "unknown" && finite(row.amount) && Math.abs(row.amount) > 0,
    );
  const quoteMints = new Set(quoteRows.map((row) => row.mint));
  const quoteMint = quoteMints.size === 1 ? [...quoteMints][0] : null;
  const avgTradeSizeQuote = quoteMint ? mean(quoteRows.map((row) => Math.abs(row.amount))) : null;

  const isSmartMoney = winRate == null || realizedRatio == null
    ? null
    : winRate > 0.6 && tradeCount > 20 && realizedRatio > 0.5;

  return {
    wallet,
    winRate,
    medianHoldSlots,
    realizedPnlSol,
    unrealizedPnlSol,
    realizedRatio,
    tradeCount,
    avgTradeSizeSol,
    avgTradeSizeQuote,
    quoteMint,
    isSmartMoney,
    historySampleSize: walletTokens.length,
  };
}

// ─────────────────────────────────────────────────────────────
// 2. Concentration Dynamics
// ─────────────────────────────────────────────────────────────

export interface ConcentrationDynamics {
  top10ShareNow: number | null;
  top10Share1hAgo: number | null;
  top10Share24hAgo: number | null;
  velocity1h: number | null;
  velocity24h: number | null;
  gini: number | null;
  /** True/false only when holder-set completeness is explicitly known. */
  giniCoverageComplete: boolean | null;
  top10Churn: number | null;
  concentrationTrend: "increasing" | "decreasing" | "stable" | "unknown";
  baseline1hAgeMinutes: number | null;
  baseline24hAgeHours: number | null;
}

function snapshotTop10(snapshot: HolderSnapshot, scale?: "share01" | "percent100"): number | null {
  if (snapshot.holders?.length) return topShare01(snapshot.holders, 10, scale ?? pctScale(snapshot.holders));
  return finite(snapshot.top10Pct) ? clamp(snapshot.top10Pct / 100) : null;
}

function nearestSnapshot(
  snapshots: HolderSnapshot[],
  targetMs: number,
  minAgeMs: number,
  maxAgeMs: number,
  referenceMs: number,
): HolderSnapshot | null {
  const candidates = snapshots.filter((snapshot) => {
    const age = referenceMs - snapshot.timestamp;
    return finite(snapshot.timestamp) && age >= minAgeMs && age <= maxAgeMs;
  });
  if (candidates.length === 0) return null;
  return candidates.reduce((best, current) =>
    Math.abs(current.timestamp - targetMs) < Math.abs(best.timestamp - targetMs) ? current : best,
  );
}

export function computeConcentrationDynamics(
  currentHolders: HolderAccount[],
  history: HolderSnapshot[],
  nowMs: number,
  scale: "share01" | "percent100" = "percent100",
): ConcentrationDynamics {
  const empty: ConcentrationDynamics = {
    top10ShareNow: null,
    top10Share1hAgo: null,
    top10Share24hAgo: null,
    velocity1h: null,
    velocity24h: null,
    gini: null,
    giniCoverageComplete: null,
    top10Churn: null,
    concentrationTrend: "unknown",
    baseline1hAgeMinutes: null,
    baseline24hAgeHours: null,
  };
  if (!finite(nowMs) || nowMs <= 0 || currentHolders.length === 0) return empty;

  const nowShare = topShare01(currentHolders, 10, scale);
  const snapshots = history.filter((snapshot) => finite(snapshot.timestamp) && snapshot.timestamp > 0 && snapshot.timestamp <= nowMs);
  const oneHour = nearestSnapshot(snapshots, nowMs - 3_600_000, 40 * 60_000, 80 * 60_000, nowMs);
  const oneDay = nearestSnapshot(snapshots, nowMs - 86_400_000, 21 * 3_600_000, 27 * 3_600_000, nowMs);
  const oneHourShare = oneHour ? snapshotTop10(oneHour, scale) : null;
  const oneDayShare = oneDay ? snapshotTop10(oneDay, scale) : null;

  const velocity1h = nowShare != null && oneHourShare != null ? nowShare - oneHourShare : null;
  const velocity24h = nowShare != null && oneDayShare != null ? (nowShare - oneDayShare) / 24 : null;

  // Gini must use one unit consistently. Holder percentages are available on every
  // row, whereas mixing token amounts with synthetic percentage fallbacks can corrupt
  // the distribution. Suppress Gini when the provider explicitly says this is only a
  // truncated largest-account set.
  const holderSetExplicitlyIncomplete = currentHolders.some((holder) => holder.holderSetComplete === false);
  const holderSetExplicitlyComplete = currentHolders.length > 0 && currentHolders.every((holder) => holder.holderSetComplete === true);
  const balances = currentHolders
    .map((holder) => finite(holder.pct) ? share01(holder.pct, scale) : null)
    .filter((value): value is number => value != null && value >= 0);

  let top10Churn: number | null = null;
  if (oneHour?.holders?.length) {
    const currentTop = new Set([...currentHolders].sort((a, b) => b.pct - a.pct).slice(0, 10).map((row) => row.address));
    const previousTop = new Set([...oneHour.holders].sort((a, b) => b.pct - a.pct).slice(0, 10).map((row) => row.address));
    top10Churn = [...currentTop].filter((address) => !previousTop.has(address)).length;
  }

  let concentrationTrend: ConcentrationDynamics["concentrationTrend"] = "unknown";
  if (velocity1h != null) {
    concentrationTrend = velocity1h > 0.02 ? "increasing" : velocity1h < -0.02 ? "decreasing" : "stable";
  }

  return {
    top10ShareNow: nowShare,
    top10Share1hAgo: oneHourShare,
    top10Share24hAgo: oneDayShare,
    velocity1h: finiteOrNull(velocity1h),
    velocity24h: finiteOrNull(velocity24h),
    gini: holderSetExplicitlyIncomplete ? null : gini(balances),
    giniCoverageComplete: holderSetExplicitlyIncomplete ? false : holderSetExplicitlyComplete ? true : null,
    top10Churn,
    concentrationTrend,
    baseline1hAgeMinutes: oneHour ? (nowMs - oneHour.timestamp) / 60_000 : null,
    baseline24hAgeHours: oneDay ? (nowMs - oneDay.timestamp) / 3_600_000 : null,
  };
}

export function computeHolderGrowth1hFromSeries(
  series: Array<{ ts: number; holders: number }>,
  nowMs: number,
  latestToleranceMs = 10 * 60_000,
): number | null {
  if (series.length < 2 || !finite(nowMs) || nowMs <= 0) return null;
  const sorted = series
    .filter((row) => finite(row.ts) && row.ts <= nowMs && finite(row.holders) && row.holders >= 0)
    .sort((a, b) => b.ts - a.ts);
  if (sorted.length < 2) return null;
  const latest = sorted[0];
  if (nowMs - latest.ts > latestToleranceMs) return null;
  const target = nowMs - 3_600_000;
  const candidates = sorted.filter((row) => {
    const age = nowMs - row.ts;
    return age >= 40 * 60_000 && age <= 80 * 60_000;
  });
  if (candidates.length === 0) return null;
  const baseline = candidates.reduce((best, row) =>
    Math.abs(row.ts - target) < Math.abs(best.ts - target) ? row : best,
  );
  return baseline.holders > 0 ? finiteOrNull((latest.holders - baseline.holders) / baseline.holders) : null;
}

// ─────────────────────────────────────────────────────────────
// 3. Order Flow Imbalance
// ─────────────────────────────────────────────────────────────

export interface WindowedFlowMetric {
  value: number | null;
  coverage: number;
  buyVolume: number | null;
  sellVolume: number | null;
  unit: "usd" | "sol" | "quote" | null;
  quoteMint: string | null;
}

export interface OrderFlowImbalance {
  ofi5m: WindowedFlowMetric;
  ofi15m: WindowedFlowMetric;
  ofi1h: WindowedFlowMetric;
  buyPressure1h: number | null;
  whaleNetFlow1h: number | null;
  retailNetFlow1h: number | null;
  solCoverage1h: number;
}

function flowWindow(
  trades: RawTrade[],
  nowSec: number,
  windowSec: number,
  explicitCoverageSec: number | null | undefined,
  historyComplete: boolean,
): WindowedFlowMetric {
  const windowTrades = trades.filter((trade) => finite(trade.timestamp) && trade.timestamp >= nowSec - windowSec && trade.timestamp <= nowSec + 1);
  const coverage = windowCoverage(windowTrades, windowSec, explicitCoverageSec, historyComplete);
  const comparable = comparableWindowNotionals(windowTrades.filter((trade) => trade.type === "buy" || trade.type === "sell"));
  if (!comparable || coverage < FLOW_MIN_COVERAGE) {
    return { value: null, coverage, buyVolume: null, sellVolume: null, unit: comparable?.unit ?? null, quoteMint: comparable?.quoteMint ?? null };
  }
  let buy = 0;
  let sell = 0;
  for (const row of comparable.rows) {
    if (row.trade.type === "buy") buy += Math.abs(row.amount);
    else if (row.trade.type === "sell") sell += Math.abs(row.amount);
  }
  const total = buy + sell;
  return {
    value: total > 0 ? clamp((buy - sell) / total, -1, 1) : null,
    coverage,
    buyVolume: finiteOrNull(buy),
    sellVolume: finiteOrNull(sell),
    unit: comparable.unit,
    quoteMint: comparable.quoteMint,
  };
}

export function computeOrderFlow(
  trades: RawTrade[],
  nowSec: number,
  explicitCoverageSec?: number | null,
  historyComplete = false,
): OrderFlowImbalance {
  const ofi5m = flowWindow(trades, nowSec, 300, explicitCoverageSec, historyComplete);
  const ofi15m = flowWindow(trades, nowSec, 900, explicitCoverageSec, historyComplete);
  const ofi1h = flowWindow(trades, nowSec, 3_600, explicitCoverageSec, historyComplete);
  const oneHour = trades.filter((trade) => finite(trade.timestamp) && trade.timestamp >= nowSec - 3_600 && trade.timestamp <= nowSec + 1);
  const marketTrades = oneHour.filter((trade) => trade.type === "buy" || trade.type === "sell");
  const solTrades = marketTrades.filter(isSolNotionalTrade);
  const solCoverage1h = marketTrades.length > 0 ? solTrades.length / marketTrades.length : 0;
  let whale = 0;
  let retail = 0;
  for (const trade of solTrades) {
    const volume = Math.abs(trade.amountSol);
    if (!(volume > 0)) continue;
    const sign = trade.type === "buy" ? 1 : -1;
    if (volume >= WHALE_THRESHOLD_SOL) whale += sign * volume;
    else retail += sign * volume;
  }
  const fullHour = ofi1h.coverage >= FLOW_MIN_COVERAGE;
  return {
    ofi5m,
    ofi15m,
    ofi1h,
    buyPressure1h: ofi1h.buyVolume != null && ofi1h.sellVolume != null && ofi1h.buyVolume + ofi1h.sellVolume > 0
      ? ofi1h.buyVolume / (ofi1h.buyVolume + ofi1h.sellVolume)
      : null,
    whaleNetFlow1h: fullHour && solCoverage1h === 1 ? finiteOrNull(whale) : null,
    retailNetFlow1h: fullHour && solCoverage1h === 1 ? finiteOrNull(retail) : null,
    solCoverage1h,
  };
}

// ─────────────────────────────────────────────────────────────
// 4. Bundle Analytics V2
// ─────────────────────────────────────────────────────────────

export interface BundleGroupInput {
  bundleId: string;
  wallets: string[];
  startTs: number;
  quoteMint: string | null;
  currentSupplyPct: number | null;
  classification: "verified_bundle" | "high_confidence_coordination" | "coordinated_buy_cluster";
  atomicBundleVerified: boolean;
}

export interface BundleAnalyticsV2 {
  available: boolean;
  bundleCount: number | null;
  walletCount: number | null;
  currentSupplyPct: number | null;
  quoteMint: string | null;
  entryPriceQuote: number | null;
  currentPriceQuote: number | null;
  bundlePnlPct: number | null;
  exitCount: number | null;
  exitRatio: number | null;
  realizedSupplyRatio: number | null;
  remainingSupplyRatio: number | null;
  sizeEntropy: number | null;
  sizeStdQuote: number | null;
  avgBundleSizeQuote: number | null;
  bundleCreatorOverlap: number | null;
  atomicBundleVerifiedCount: number | null;
}

export function latestTradePriceQuote(trades: RawTrade[]): { quoteMint: string | null; price: number | null } {
  const priced = trades
    .map((trade) => ({ trade, mint: tradeQuoteMint(trade), price: tradePriceQuote(trade) }))
    .filter((row) => row.mint !== "unknown" && row.price != null)
    .sort((a, b) => b.trade.timestamp - a.trade.timestamp);
  if (priced.length === 0) return { quoteMint: null, price: null };
  const latestMint = priced[0].mint;
  const latest = priced.find((row) => row.mint === latestMint);
  return { quoteMint: latestMint, price: latest?.price ?? null };
}

export function computeBundleAnalyticsV2(
  groups: BundleGroupInput[],
  trades: RawTrade[],
  currentSupplyPct: number | null,
  creatorFundedWallets: Set<string>,
  evidenceAvailable: boolean,
): BundleAnalyticsV2 {
  if (!evidenceAvailable) {
    return {
      available: false,
      bundleCount: null,
      walletCount: null,
      currentSupplyPct: null,
      quoteMint: null,
      entryPriceQuote: null,
      currentPriceQuote: null,
      bundlePnlPct: null,
      exitCount: null,
      exitRatio: null,
      realizedSupplyRatio: null,
      remainingSupplyRatio: null,
      sizeEntropy: null,
      sizeStdQuote: null,
      avgBundleSizeQuote: null,
      bundleCreatorOverlap: null,
      atomicBundleVerifiedCount: null,
    };
  }
  if (groups.length === 0) {
    return {
      available: true,
      bundleCount: 0,
      walletCount: 0,
      currentSupplyPct: finiteOrNull(currentSupplyPct),
      quoteMint: null,
      entryPriceQuote: null,
      currentPriceQuote: null,
      bundlePnlPct: null,
      exitCount: 0,
      exitRatio: null,
      realizedSupplyRatio: null,
      remainingSupplyRatio: null,
      sizeEntropy: null,
      sizeStdQuote: null,
      avgBundleSizeQuote: null,
      bundleCreatorOverlap: 0,
      atomicBundleVerifiedCount: 0,
    };
  }

  const wallets = new Set(groups.flatMap((group) => group.wallets));
  const quoteMints = new Set(groups.map((group) => group.quoteMint).filter((mint): mint is string => Boolean(mint)));
  const quoteMint = quoteMints.size === 1 ? [...quoteMints][0] : null;
  const walletEntryStart = new Map<string, number>();
  for (const group of groups) {
    for (const wallet of group.wallets) {
      const previous = walletEntryStart.get(wallet);
      if (previous == null || group.startTs < previous) walletEntryStart.set(wallet, group.startTs);
    }
  }
  const allEntries = trades.filter((trade) => {
    if (trade.type !== "buy" || !wallets.has(trade.trader)) return false;
    const start = walletEntryStart.get(trade.trader);
    return start != null && trade.timestamp >= start - 1 && trade.timestamp <= start + 10;
  });
  // Quote-dependent metrics are computed only when all bundle groups share one known quote asset.
  const pricedEntries = quoteMint == null ? [] : allEntries.filter((trade) => tradeQuoteMint(trade) === quoteMint);
  const pricedEntryTokensKnown = pricedEntries.length > 0 && pricedEntries.every((trade) => finite(trade.amountTokens) && trade.amountTokens > 0);
  const pricedEntryTokens = pricedEntryTokensKnown ? pricedEntries.reduce((sum, trade) => sum + trade.amountTokens, 0) : null;
  const entryQuoteAmounts = pricedEntries.map(tradeQuoteAmount);
  const entryQuoteKnown = pricedEntries.length > 0 && entryQuoteAmounts.every((value): value is number => finite(value));
  const entryQuote = entryQuoteKnown ? entryQuoteAmounts.reduce((sum, value) => sum + Math.abs(value), 0) : null;
  const entryPriceQuote = pricedEntryTokens != null && pricedEntryTokens > 0 && entryQuote != null && entryQuote > 0
    ? entryQuote / pricedEntryTokens
    : null;

  const latest = quoteMint == null
    ? { quoteMint: null, price: null }
    : latestTradePriceQuote(trades.filter((trade) => tradeQuoteMint(trade) === quoteMint));
  const currentPriceQuote = quoteMint != null && latest.quoteMint === quoteMint ? latest.price : null;
  const bundlePnlPct = entryPriceQuote != null && currentPriceQuote != null && entryPriceQuote > 0
    ? finiteOrNull((currentPriceQuote - entryPriceQuote) / entryPriceQuote)
    : null;

  const walletBought = new Map<string, number>();
  const walletSold = new Map<string, number>();
  for (const trade of trades) {
    if (!wallets.has(trade.trader) || !finite(trade.amountTokens) || !(trade.amountTokens > 0)) continue;
    const start = walletEntryStart.get(trade.trader);
    if (start == null) continue;
    if (trade.type === "buy" && trade.timestamp >= start - 1 && trade.timestamp <= start + 10) {
      walletBought.set(trade.trader, (walletBought.get(trade.trader) ?? 0) + trade.amountTokens);
    }
    if (trade.type === "sell" && trade.timestamp >= start) {
      walletSold.set(trade.trader, (walletSold.get(trade.trader) ?? 0) + trade.amountTokens);
    }
  }
  const entryObservedWallets = [...wallets].filter((wallet) => (walletBought.get(wallet) ?? 0) > 0);
  const totalBoughtTokens = entryObservedWallets.reduce((sum, wallet) => sum + (walletBought.get(wallet) ?? 0), 0);
  // Bundle-realized supply can never exceed the measured bundle entry. A wallet may
  // sell pre-existing inventory after the cluster, so cap every wallet's attributed
  // sell amount at its observed bundle entry instead of treating all later sells as
  // bundle liquidation.
  const attributedSoldTokens = entryObservedWallets.reduce((sum, wallet) => {
    const bought = walletBought.get(wallet) ?? 0;
    const sold = walletSold.get(wallet) ?? 0;
    return sum + Math.min(bought, sold);
  }, 0);
  const realizedSupplyRatio = totalBoughtTokens > 0 ? clamp(attributedSoldTokens / totalBoughtTokens) : null;
  const remainingSupplyRatio = realizedSupplyRatio != null ? clamp(1 - realizedSupplyRatio) : null;
  const exited = entryObservedWallets.filter((wallet) => {
    const bought = walletBought.get(wallet) ?? 0;
    const sold = walletSold.get(wallet) ?? 0;
    return sold / bought >= 0.95;
  }).length;
  const exitRatio = entryObservedWallets.length > 0 ? exited / entryObservedWallets.length : null;

  const sizes = groups.map((group) => {
    const groupWallets = new Set(group.wallets);
    if (quoteMint == null) return null;
    const rows = pricedEntries.filter((trade) => groupWallets.has(trade.trader));
    if (rows.length === 0) return null;
    const mints = new Set(rows.map(tradeQuoteMint));
    if (mints.size !== 1) return null;
    const amounts = rows.map(tradeQuoteAmount);
    if (!amounts.every((value): value is number => finite(value))) return null;
    const size = amounts.reduce((sum, value) => sum + Math.abs(value), 0);
    return finite(size) && size > 0 ? size : null;
  }).filter((value): value is number => value != null);

  const binCounts = (() => {
    if (sizes.length === 0) return [] as number[];
    const min = Math.min(...sizes);
    const max = Math.max(...sizes);
    const width = Math.max(EPS, max - min);
    const bins = new Array<number>(10).fill(0);
    for (const size of sizes) bins[Math.min(9, Math.floor(((size - min) / width) * 10))] += 1;
    return bins;
  })();

  return {
    available: true,
    bundleCount: groups.length,
    walletCount: wallets.size,
    currentSupplyPct: finiteOrNull(currentSupplyPct),
    quoteMint,
    entryPriceQuote: finiteOrNull(entryPriceQuote),
    currentPriceQuote: finiteOrNull(currentPriceQuote),
    bundlePnlPct,
    exitCount: exited,
    exitRatio: finiteOrNull(exitRatio),
    realizedSupplyRatio: finiteOrNull(realizedSupplyRatio),
    remainingSupplyRatio: finiteOrNull(remainingSupplyRatio),
    sizeEntropy: entropy(binCounts),
    sizeStdQuote: std(sizes),
    avgBundleSizeQuote: mean(sizes),
    bundleCreatorOverlap: [...wallets].filter((wallet) => creatorFundedWallets.has(wallet)).length,
    atomicBundleVerifiedCount: groups.filter((group) => group.atomicBundleVerified).length,
  };
}

// ─────────────────────────────────────────────────────────────
// 5. Funding Tree
// ─────────────────────────────────────────────────────────────

export interface FundingTree {
  available: boolean;
  maxDepth: number | null;
  rootCount: number | null;
  leafCount: number | null;
  uniqueFunders: number | null;
  diversityRatio: number | null;
  timingBurst: boolean | null;
  timingStdMs: number | null;
  amountEntropy: number | null;
  amountStdLamports: number | null;
  verifiedEdges: number | null;
  partialEdges: number | null;
  lowConfidenceEdges: number | null;
  coverage: number | null;
  /** Cycles make hierarchy depth undefined; reported explicitly instead of hiding them. */
  cycleDetected: boolean | null;
}

export function computeFundingTree(
  edges: FundingEdge[],
  evidenceAvailable: boolean,
  evidenceComplete: boolean,
): FundingTree {
  if (!evidenceAvailable) {
    return {
      available: false,
      maxDepth: null,
      rootCount: null,
      leafCount: null,
      uniqueFunders: null,
      diversityRatio: null,
      timingBurst: null,
      timingStdMs: null,
      amountEntropy: null,
      amountStdLamports: null,
      verifiedEdges: null,
      partialEdges: null,
      lowConfidenceEdges: null,
      coverage: null,
      cycleDetected: null,
    };
  }

  const verified = edges.filter((edge) => edge.historyComplete && finite(edge.confidence) && edge.confidence >= VERIFIED_FUNDING_CONFIDENCE);
  const partial = edges.filter((edge) => !edge.historyComplete && finite(edge.confidence) && edge.confidence >= VERIFIED_FUNDING_CONFIDENCE);
  const low = edges.filter((edge) => !finite(edge.confidence) || edge.confidence < VERIFIED_FUNDING_CONFIDENCE);
  if (edges.length === 0) {
    return {
      available: true,
      maxDepth: evidenceComplete ? 0 : null,
      rootCount: evidenceComplete ? 0 : null,
      leafCount: evidenceComplete ? 0 : null,
      uniqueFunders: evidenceComplete ? 0 : null,
      diversityRatio: evidenceComplete ? 0 : null,
      timingBurst: evidenceComplete ? false : null,
      timingStdMs: null,
      amountEntropy: null,
      amountStdLamports: null,
      verifiedEdges: 0,
      partialEdges: 0,
      lowConfidenceEdges: 0,
      coverage: evidenceComplete ? 1 : 0,
      cycleDetected: evidenceComplete ? false : null,
    };
  }

  const children = new Map<string, string[]>();
  const incoming = new Set<string>();
  const allNodes = new Set<string>();
  for (const edge of verified) {
    allNodes.add(edge.source);
    allNodes.add(edge.target);
    incoming.add(edge.target);
    const list = children.get(edge.source) ?? [];
    list.push(edge.target);
    children.set(edge.source, list);
  }
  const roots = [...allNodes].filter((node) => !incoming.has(node));
  const leaves = [...allNodes].filter((node) => (children.get(node)?.length ?? 0) === 0);

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const hasCycleFrom = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const child of children.get(node) ?? []) {
      if (hasCycleFrom(child)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  const cycleDetected = [...allNodes].some((node) => hasCycleFrom(node));

  const memo = new Map<string, number>();
  const depthFrom = (node: string, path: Set<string>): number => {
    if (path.has(node)) return 0;
    const cached = memo.get(node);
    if (cached != null) return cached;
    const nextPath = new Set(path);
    nextPath.add(node);
    const kids = children.get(node) ?? [];
    const depth = kids.length === 0 ? 0 : 1 + Math.max(...kids.map((kid) => depthFrom(kid, nextPath)));
    memo.set(node, depth);
    return depth;
  };
  const startNodes = roots.length > 0 ? roots : [...allNodes];
  const maxDepth = startNodes.length > 0 ? Math.max(...startNodes.map((node) => depthFrom(node, new Set()))) : 0;

  const times = verified.map((edge) => edge.blockTime).filter((value): value is number => finite(value) && value > 0);
  const timingStdMs = times.length >= 2 ? std(times.map((value) => value * 1000)) : null;
  const timingBurst = timingStdMs != null ? timingStdMs < FUNDING_BURST_THRESHOLD_MS : null;
  const amounts = verified.map((edge) => Math.abs(edge.lamports)).filter((value) => finite(value) && value > 0);
  const bins = (() => {
    if (amounts.length === 0) return [] as number[];
    const min = Math.min(...amounts);
    const max = Math.max(...amounts);
    const width = Math.max(EPS, max - min);
    const out = new Array<number>(10).fill(0);
    for (const amount of amounts) out[Math.min(9, Math.floor(((amount - min) / width) * 10))] += 1;
    return out;
  })();

  const uniqueFunders = new Set(verified.map((edge) => edge.source)).size;
  return {
    available: true,
    maxDepth: verified.length > 0 ? (cycleDetected ? null : maxDepth) : evidenceComplete ? 0 : null,
    rootCount: verified.length > 0 ? roots.length : evidenceComplete ? 0 : null,
    leafCount: verified.length > 0 ? leaves.length : evidenceComplete ? 0 : null,
    uniqueFunders: verified.length > 0 ? uniqueFunders : evidenceComplete ? 0 : null,
    diversityRatio: verified.length > 0 ? clamp(uniqueFunders / verified.length) : evidenceComplete ? 0 : null,
    timingBurst,
    timingStdMs,
    amountEntropy: entropy(bins),
    amountStdLamports: std(amounts),
    verifiedEdges: verified.length,
    partialEdges: partial.length,
    lowConfidenceEdges: low.length,
    coverage: edges.length > 0 ? clamp(verified.length / edges.length) : evidenceComplete ? 1 : 0,
    cycleDetected: verified.length > 0 ? cycleDetected : evidenceComplete ? false : null,
  };
}

// ─────────────────────────────────────────────────────────────
// 6. Wash Trading V2
// ─────────────────────────────────────────────────────────────

export interface WashTradingV2 {
  available: boolean;
  walletCount: number | null;
  walletSharePct: number | null;
  circularPatterns: number | null;
  volumePriceMismatch: boolean | null;
  benfordScore: number | null;
  tradeSizeEntropy: number | null;
  suspiciousPairs: number | null;
  matchedPairEvents: number | null;
}

function notionalSimilarity(a: RawTrade, b: RawTrade): number | null {
  if (tradeQuoteMint(a) !== tradeQuoteMint(b)) return null;
  const aAmount = tradeQuoteAmount(a);
  const bAmount = tradeQuoteAmount(b);
  if (!finite(aAmount) || !finite(bAmount)) return null;
  const av = Math.abs(aAmount);
  const bv = Math.abs(bAmount);
  const base = Math.max(av, bv);
  if (!(base > 0)) return null;
  return Math.abs(av - bv) / base;
}

export function computeWashTradingV2(
  trades: RawTrade[],
  suspiciousWallets: Set<string>,
  totalObservedWallets: number,
  evidenceAvailable: boolean,
  coverageSec?: number | null,
  analysisNowSec?: number | null,
): WashTradingV2 {
  if (!evidenceAvailable) {
    return {
      available: false,
      walletCount: null,
      walletSharePct: null,
      circularPatterns: null,
      volumePriceMismatch: null,
      benfordScore: null,
      tradeSizeEntropy: null,
      suspiciousPairs: null,
      matchedPairEvents: null,
    };
  }

  const nowSec = finite(analysisNowSec)
    ? analysisNowSec
    : trades.map((trade) => trade.timestamp).filter(finite).sort((a, b) => b - a)[0] ?? null;
  const scopedTrades = nowSec == null
    ? trades
    : trades.filter((trade) => finite(trade.timestamp) && trade.timestamp >= nowSec - WASH_LOOKBACK_SEC && trade.timestamp <= nowSec + 1);

  const tradingWallets = new Set(
    scopedTrades.filter((trade) => trade.type === "buy" || trade.type === "sell").map((trade) => trade.trader).filter(Boolean),
  );
  const observedSuspiciousWallets = new Set([...suspiciousWallets].filter((wallet) => tradingWallets.has(wallet)));
  const buysBySlot = new Map<number, RawTrade[]>();
  const directed = new Map<string, number>();
  const grossToken = new Map<string, number>();
  const netToken = new Map<string, number>();
  let matchedPairEvents = 0;

  for (const trade of scopedTrades) {
    if (!observedSuspiciousWallets.has(trade.trader) || !finite(trade.slot) || !finite(trade.amountTokens) || !(trade.amountTokens > 0)) continue;
    if (trade.type !== "buy" && trade.type !== "sell") continue;
    const gross = grossToken.get(trade.trader) ?? 0;
    const net = netToken.get(trade.trader) ?? 0;
    grossToken.set(trade.trader, gross + trade.amountTokens);
    netToken.set(trade.trader, net + (trade.type === "buy" ? trade.amountTokens : -trade.amountTokens));
    if (trade.type !== "buy") continue;
    const list = buysBySlot.get(trade.slot) ?? [];
    list.push(trade);
    buysBySlot.set(trade.slot, list);
  }

  for (const sell of scopedTrades) {
    if (sell.type !== "sell" || !observedSuspiciousWallets.has(sell.trader) || !finite(sell.slot)) continue;
    for (let slot = sell.slot - WASH_WINDOW_SLOTS; slot <= sell.slot; slot++) {
      const buys = buysBySlot.get(slot);
      if (!buys) continue;
      for (const buy of buys) {
        if (buy.trader === sell.trader) continue;
        const similarity = notionalSimilarity(buy, sell);
        if (similarity == null || similarity > 0.1) continue;
        const key = `${buy.trader}|${sell.trader}`;
        directed.set(key, (directed.get(key) ?? 0) + 1);
        matchedPairEvents += 1;
      }
    }
  }

  const normalizedExposure = (wallet: string): number | null => {
    const gross = grossToken.get(wallet) ?? 0;
    return gross > 0 ? Math.abs(netToken.get(wallet) ?? 0) / gross : null;
  };
  const unorderedPairs = new Set<string>();
  for (const key of directed.keys()) {
    const [a, b] = key.split("|");
    unorderedPairs.add([a, b].sort().join("|"));
  }
  let suspiciousPairs = 0;
  for (const pair of unorderedPairs) {
    const [a, b] = pair.split("|");
    const ab = directed.get(`${a}|${b}`) ?? 0;
    const ba = directed.get(`${b}|${a}`) ?? 0;
    const aExposure = normalizedExposure(a);
    const bExposure = normalizedExposure(b);
    if (ab >= WASH_PAIR_THRESHOLD && ba >= WASH_PAIR_THRESHOLD && aExposure != null && bExposure != null && aExposure <= 0.2 && bExposure <= 0.2) {
      suspiciousPairs += 1;
    }
  }

  const comparableAll = comparableWindowNotionals(scopedTrades.filter((trade) => trade.type === "buy" || trade.type === "sell"));
  const sizes = comparableAll ? comparableAll.rows.map((row) => row.amount).filter((value) => value > 0) : [];
  const leading = new Array<number>(9).fill(0);
  for (const size of sizes) {
    const exponent = Math.floor(Math.log10(size));
    const digit = Math.floor(size / 10 ** exponent);
    if (digit >= 1 && digit <= 9) leading[digit - 1] += 1;
  }
  let benfordScore: number | null = null;
  const totalDigits = leading.reduce((sum, value) => sum + value, 0);
  if (totalDigits >= 30) {
    const expectedPct = [30.1, 17.6, 12.5, 9.7, 7.9, 6.7, 5.8, 5.1, 4.6];
    let chiSquare = 0;
    for (let i = 0; i < leading.length; i++) {
      const observed = (leading[i] / totalDigits) * 100;
      chiSquare += (observed - expectedPct[i]) ** 2 / expectedPct[i];
    }
    benfordScore = clamp(chiSquare / 30);
  }
  const bins = (() => {
    if (sizes.length === 0) return [] as number[];
    const min = Math.min(...sizes);
    const max = Math.max(...sizes);
    const width = Math.max(EPS, max - min);
    const out = new Array<number>(10).fill(0);
    for (const size of sizes) out[Math.min(9, Math.floor(((size - min) / width) * 10))] += 1;
    return out;
  })();

  let volumePriceMismatch: boolean | null = null;
  if (nowSec != null && finite(coverageSec) && coverageSec >= 900) {
    const recent = trades.filter((trade) => trade.timestamp >= nowSec - 900 && trade.timestamp <= nowSec + 1 && (trade.type === "buy" || trade.type === "sell"));
    const comparable = comparableWindowNotionals(recent);
    const prices = comparable?.unit === "usd"
      ? recent.map((trade) => {
          if (!(finite(trade.quoteUsdValue) && finite(trade.amountTokens) && trade.amountTokens > 0)) return null;
          const price = Math.abs(trade.quoteUsdValue) / trade.amountTokens;
          return finite(price) && price > 0 ? price : null;
        }).filter((value): value is number => value != null)
      : recent.map(tradePriceQuote).filter((value): value is number => value != null && value > 0);
    if (comparable && prices.length >= 2) {
      const totalVolume = comparable.rows.reduce((sum, row) => sum + row.amount, 0);
      const avgPrice = mean(prices);
      const range = Math.max(...prices) - Math.min(...prices);
      const priceRangePct = avgPrice != null && avgPrice > 0 ? range / avgPrice : null;
      const highVolume = comparable.unit === "sol" ? totalVolume >= 100 : comparable.unit === "usd" ? totalVolume >= 10_000 : false;
      volumePriceMismatch = highVolume && priceRangePct != null ? priceRangePct < 0.02 : null;
    }
  }

  return {
    available: true,
    walletCount: observedSuspiciousWallets.size,
    // Numerator and denominator must describe the same temporal population. Using
    // launch+recent all-time wallets here would dilute a current 1h wash cluster.
    walletSharePct: tradingWallets.size > 0 ? clamp((observedSuspiciousWallets.size / tradingWallets.size) * 100, 0, 100) : null,
    circularPatterns: suspiciousPairs,
    volumePriceMismatch,
    benfordScore,
    tradeSizeEntropy: entropy(bins),
    suspiciousPairs,
    matchedPairEvents,
  };
}

// ─────────────────────────────────────────────────────────────
// 7. Lifecycle Stage
// ─────────────────────────────────────────────────────────────

export type LifecycleStage = "ignition" | "acceleration" | "broad_discovery" | "saturation" | "exhaustion" | "decay" | "uncertain";

export interface LifecycleResult {
  stage: LifecycleStage;
  confidence: number;
  rulesTriggered: string[];
}

export interface LifecycleInput {
  ageSlots: number | null;
  uniqueBuyersZ: number | null;
  holderGrowth1h: number | null;
  ofi15m: number | null;
  concentrationVelocity1h: number | null;
  bundlePnlPct: number | null;
  liquidityUsd: number | null;
  volumeGrowth1h: number | null;
}

export function detectLifecycleStage(input: LifecycleInput): LifecycleResult {
  if (input.ageSlots != null && input.ageSlots < 1_000 && input.uniqueBuyersZ != null && input.uniqueBuyersZ > 2 && input.liquidityUsd != null && input.liquidityUsd < 50_000) {
    return { stage: "ignition", confidence: 0.7, rulesTriggered: ["age < 1000 slots", "uniqueBuyersZ > 2", "liquidity < 50k"] };
  }
  if (input.uniqueBuyersZ != null && input.uniqueBuyersZ > 1.5 && input.ofi15m != null && input.ofi15m > 0.2 && input.holderGrowth1h != null && input.holderGrowth1h > 0.1) {
    return { stage: "acceleration", confidence: 0.78, rulesTriggered: ["uniqueBuyersZ > 1.5", "ofi15m > 0.2", "holderGrowth1h > 10%"] };
  }
  if (input.holderGrowth1h != null && input.holderGrowth1h > 0.05 && input.uniqueBuyersZ != null && input.uniqueBuyersZ < 1) {
    return { stage: "broad_discovery", confidence: 0.65, rulesTriggered: ["holderGrowth1h > 5%", "uniqueBuyersZ < 1"] };
  }
  if (input.concentrationVelocity1h != null && input.concentrationVelocity1h > 0.03 && input.bundlePnlPct != null && input.bundlePnlPct > 1) {
    return { stage: "saturation", confidence: 0.72, rulesTriggered: ["concentrationVelocity1h > 3%", "bundlePnlPct > 100%"] };
  }
  if (input.uniqueBuyersZ != null && input.uniqueBuyersZ < -1 && input.concentrationVelocity1h != null && input.concentrationVelocity1h < -0.03) {
    return { stage: "exhaustion", confidence: 0.72, rulesTriggered: ["uniqueBuyersZ < -1", "concentrationVelocity1h < -3%"] };
  }
  if (input.holderGrowth1h != null && input.holderGrowth1h < -0.05 && input.ofi15m != null && input.ofi15m < -0.2) {
    return { stage: "decay", confidence: 0.78, rulesTriggered: ["holderGrowth1h < -5%", "ofi15m < -0.2"] };
  }
  if (input.volumeGrowth1h != null && input.volumeGrowth1h > 1 && input.ofi15m != null && input.ofi15m > 0.15) {
    return { stage: "acceleration", confidence: 0.6, rulesTriggered: ["volumeGrowth1h > 100%", "ofi15m > 0.15"] };
  }
  return { stage: "uncertain", confidence: 0.4, rulesTriggered: [] };
}

// ─────────────────────────────────────────────────────────────
// 8. Contradictions
// ─────────────────────────────────────────────────────────────

export type ContradictionType =
  | "holder_growth_vs_buyers"
  | "volume_vs_price"
  | "bundle_profit_vs_exit"
  | "creator_funded_vs_no_sell"
  | "concentration_vs_distribution"
  | "whale_flow_vs_retail"
  | "ofi_vs_price";

export interface Contradiction {
  type: ContradictionType;
  description: string;
  evidence: string[];
  severity: number;
}

export interface ContradictionInput {
  holderGrowth1h: number | null;
  uniqueBuyersZ: number | null;
  volumeGrowth1h: number | null;
  priceChangePct15m: number | null;
  bundlePnlPct: number | null;
  bundleExitRatio: number | null;
  creatorFundedWallets: number | null;
  creatorSoldPct: number | null;
  creatorSellCoverageComplete: boolean;
  concentrationVelocity1h: number | null;
  whaleNetFlow1h: number | null;
  retailNetFlow1h: number | null;
  ofi15m: number | null;
}

export function detectContradictions(input: ContradictionInput): Contradiction[] {
  const out: Contradiction[] = [];
  if (input.holderGrowth1h != null && input.holderGrowth1h > 0.05 && input.uniqueBuyersZ != null && input.uniqueBuyersZ < -0.5) {
    out.push({ type: "holder_growth_vs_buyers", description: "Holder count grows while observed new-buyer momentum weakens.", evidence: [`holderGrowth1h=${(input.holderGrowth1h * 100).toFixed(1)}%`, `uniqueBuyersZ=${input.uniqueBuyersZ.toFixed(2)}`], severity: 0.6 });
  }
  if (input.volumeGrowth1h != null && input.volumeGrowth1h > 0.5 && input.priceChangePct15m != null && Math.abs(input.priceChangePct15m) < 0.02) {
    out.push({ type: "volume_vs_price", description: "Volume rises while 15m price remains flat; absorption or non-directional activity needs review.", evidence: [`volumeGrowth1h=${(input.volumeGrowth1h * 100).toFixed(1)}%`, `priceChange15m=${(input.priceChangePct15m * 100).toFixed(2)}%`], severity: 0.55 });
  }
  if (input.bundlePnlPct != null && input.bundlePnlPct > 2 && input.bundleExitRatio != null && input.bundleExitRatio < 0.1) {
    out.push({ type: "bundle_profit_vs_exit", description: "Coordinated-entry wallets are deeply profitable but show little measured exit activity.", evidence: [`bundlePnlPct=${(input.bundlePnlPct * 100).toFixed(0)}%`, `bundleExitRatio=${input.bundleExitRatio.toFixed(2)}`], severity: 0.5 });
  }
  if (input.creatorFundedWallets != null && input.creatorFundedWallets > 0 && input.creatorSellCoverageComplete && input.creatorSoldPct === 0) {
    out.push({ type: "creator_funded_vs_no_sell", description: "Creator-linked funding is observed while complete sell coverage shows no creator sell.", evidence: [`creatorFundedWallets=${input.creatorFundedWallets}`, "creatorSoldPct=0 with complete sell coverage"], severity: 0.7 });
  }
  if (input.concentrationVelocity1h != null && input.concentrationVelocity1h > 0.03 && input.holderGrowth1h != null && input.holderGrowth1h > 0.1) {
    out.push({ type: "concentration_vs_distribution", description: "Top-holder concentration rises while holder count also grows.", evidence: [`concentrationVelocity1h=${(input.concentrationVelocity1h * 100).toFixed(1)}pp`, `holderGrowth1h=${(input.holderGrowth1h * 100).toFixed(1)}%`], severity: 0.55 });
  }
  if (input.whaleNetFlow1h != null && input.retailNetFlow1h != null && Math.sign(input.whaleNetFlow1h) !== 0 && Math.sign(input.whaleNetFlow1h) !== Math.sign(input.retailNetFlow1h)) {
    out.push({ type: "whale_flow_vs_retail", description: "Whale and retail SOL flows point in opposite directions.", evidence: [`whaleNetFlow1h=${input.whaleNetFlow1h.toFixed(2)} SOL`, `retailNetFlow1h=${input.retailNetFlow1h.toFixed(2)} SOL`], severity: 0.65 });
  }
  if (input.ofi15m != null && input.ofi15m > 0.3 && input.priceChangePct15m != null && input.priceChangePct15m < -0.05) {
    out.push({ type: "ofi_vs_price", description: "Positive 15m buy-flow imbalance coincides with falling price (buy-flow / price divergence).", evidence: [`ofi15m=${input.ofi15m.toFixed(2)}`, `priceChange15m=${(input.priceChangePct15m * 100).toFixed(2)}%`], severity: 0.65 });
  }
  return out;
}

export function priceChangePctWindow(trades: RawTrade[], nowSec: number, windowSec = 900): number | null {
  const rows = trades
    .filter((trade) => trade.timestamp >= nowSec - windowSec && trade.timestamp <= nowSec + 1)
    .map((trade) => ({ timestamp: trade.timestamp, mint: tradeQuoteMint(trade), price: tradePriceQuote(trade) }))
    .filter((row): row is { timestamp: number; mint: string; price: number } => row.mint !== "unknown" && row.price != null && row.price > 0)
    .sort((a, b) => a.timestamp - b.timestamp);
  if (rows.length < 2) return null;
  const mint = rows[rows.length - 1].mint;
  const same = rows.filter((row) => row.mint === mint);
  if (same.length < 2) return null;
  const first = same[0].price;
  const last = same[same.length - 1].price;
  return first > 0 ? finiteOrNull((last - first) / first) : null;
}

// ─────────────────────────────────────────────────────────────
// 9. Confidence
// ─────────────────────────────────────────────────────────────

export interface ScoreConfidence {
  value: number;
  components: {
    sampleSize: number;
    dataCompleteness: number;
    signalAgreement: number;
    historicalCalibration: number;
  };
  penalties: string[];
}

export interface ConfidenceInput {
  tradeCount: number;
  holderCount: number;
  requiredFieldsPresent: number;
  requiredFieldsTotal: number;
  /** Normalized 0..1 evidence values with the same semantic direction. */
  signalScores01: Array<number | null>;
  historicalCalibration?: number | null;
}

export function computeScoreConfidence(input: ConfidenceInput): ScoreConfidence {
  const sampleSize = clamp((Math.max(0, input.tradeCount) + Math.max(0, input.holderCount)) / 200);
  const dataCompleteness = input.requiredFieldsTotal > 0 ? clamp(input.requiredFieldsPresent / input.requiredFieldsTotal) : 0;
  const signals = input.signalScores01.filter((value): value is number => finite(value)).map((value) => clamp(value));
  let signalAgreement = signals.length === 1 ? 0.5 : signals.length === 0 ? 0 : 1;
  if (signals.length > 1) {
    // Agreement should measure dispersion, not distance from zero. Pairwise absolute
    // distance is naturally bounded for normalized 0..1 evidence: identical signals
    // agree at 1 even when both are 0, while opposite endpoints [0,1] agree at 0.
    let distanceSum = 0;
    let pairs = 0;
    for (let i = 0; i < signals.length; i++) {
      for (let j = i + 1; j < signals.length; j++) {
        distanceSum += Math.abs(signals[i] - signals[j]);
        pairs += 1;
      }
    }
    signalAgreement = pairs > 0 ? clamp(1 - distanceSum / pairs) : 0.5;
  }
  const historicalCalibration = finite(input.historicalCalibration) ? clamp(input.historicalCalibration!) : 0.5;
  const value = clamp(sampleSize * 0.3 + dataCompleteness * 0.3 + signalAgreement * 0.2 + historicalCalibration * 0.2);
  const penalties: string[] = [];
  if (input.tradeCount < 50) penalties.push("low trade count");
  if (input.holderCount < 20) penalties.push("low holder count");
  if (dataCompleteness < 0.8) penalties.push("missing fields");
  if (signalAgreement < 0.5) penalties.push("signal disagreement");
  return { value, components: { sampleSize, dataCompleteness, signalAgreement, historicalCalibration }, penalties };
}

// ─────────────────────────────────────────────────────────────
// 10. Composite Scores
// ─────────────────────────────────────────────────────────────

export interface ScoreWithConfidence {
  value: number | null;
  confidence: ScoreConfidence;
  reasons: string[];
}

export interface CompositeScores {
  smartMoneyScore: ScoreWithConfidence;
  coordinationScoreV2: ScoreWithConfidence;
  organicGrowthScore: ScoreWithConfidence;
  distributionRiskScore: ScoreWithConfidence;
  demandMomentumScore: ScoreWithConfidence;
  /** Null until an actual narrative input (X/Telegram/on-chain narrative model) is supplied. */
  narrativeMomentumScore: ScoreWithConfidence;
}

export interface CompositeInput {
  walletPerformances: WalletPerformance[];
  bundleAnalytics: BundleAnalyticsV2;
  fundingTree: FundingTree;
  washTrading: WashTradingV2;
  concentration: ConcentrationDynamics;
  orderFlow: OrderFlowImbalance;
  holderGrowth1h: number | null;
  uniqueBuyersZ: number | null;
  narrativeSignal01?: number | null;
  /** Absence of bundle evidence is meaningful only when the relevant trade history is complete. */
  bundleEvidenceComplete?: boolean;
  /** Absence of wash evidence is meaningful only when trade history is complete. */
  washEvidenceComplete?: boolean;
  tradeCount: number;
  holderCount: number;
}

function confidenceFor(input: CompositeInput, required: Array<boolean>, signals: Array<number | null>): ScoreConfidence {
  return computeScoreConfidence({
    tradeCount: input.tradeCount,
    holderCount: input.holderCount,
    requiredFieldsPresent: required.filter(Boolean).length,
    requiredFieldsTotal: required.length,
    signalScores01: signals,
  });
}

function score(value: number | null, confidence: ScoreConfidence, reasons: string[]): ScoreWithConfidence {
  return { value: value == null ? null : clamp(value, 0, 100), confidence, reasons };
}

export function computeCompositeScores(input: CompositeInput): CompositeScores {
  const knownSmart = input.walletPerformances.filter((row) => row.isSmartMoney != null);
  const smartCount = knownSmart.filter((row) => row.isSmartMoney === true).length;
  const smartValue = knownSmart.length > 0 ? clamp((smartCount / knownSmart.length) * 200, 0, 100) : null;
  const smartConfidence = confidenceFor(
    input,
    [knownSmart.length > 0, input.walletPerformances.some((row) => row.realizedRatio != null), input.walletPerformances.some((row) => row.winRate != null)],
    input.walletPerformances.map((row) => row.winRate),
  );

  const bundleCoordinationSignal = input.bundleAnalytics.available
    && input.bundleAnalytics.bundleCount != null
    && input.bundleAnalytics.atomicBundleVerifiedCount != null
    ? input.bundleAnalytics.atomicBundleVerifiedCount > 0
      ? clamp(input.bundleAnalytics.atomicBundleVerifiedCount / Math.max(1, input.bundleAnalytics.bundleCount))
      : input.bundleEvidenceComplete === true ? 0 : null
    : null;
  const fundingCoordinationSignal = input.fundingTree.available && input.fundingTree.timingBurst != null
    ? input.fundingTree.timingBurst === true
      ? 1
      : input.fundingTree.coverage === 1 ? 0 : null
    : null;
  const washCoordinationSignal = input.washTrading.available && input.washTrading.suspiciousPairs != null
    ? input.washTrading.suspiciousPairs > 0
      ? clamp(input.washTrading.suspiciousPairs / 5)
      : input.washEvidenceComplete === true ? 0 : null
    : null;
  const coordinationSignals: Array<number | null> = [
    bundleCoordinationSignal,
    fundingCoordinationSignal,
    washCoordinationSignal,
  ];
  const coordKnown = coordinationSignals.filter((value): value is number => value != null);
  const coordinationValue = coordKnown.length >= 2 ? (mean(coordKnown)! * 100) : null;
  const coordinationConfidence = confidenceFor(input, [coordKnown.length >= 2, input.fundingTree.coverage != null, input.bundleAnalytics.exitRatio != null], coordinationSignals);

  const organicSignals: Array<number | null> = [
    input.uniqueBuyersZ != null ? clamp((input.uniqueBuyersZ + 2) / 4) : null,
    input.holderGrowth1h != null ? clamp(0.5 + input.holderGrowth1h * 2.5) : null,
    input.concentration.concentrationTrend === "decreasing" ? 1 : input.concentration.concentrationTrend === "stable" ? 0.6 : input.concentration.concentrationTrend === "increasing" ? 0.2 : null,
    input.washEvidenceComplete === true && input.washTrading.walletSharePct != null
      ? clamp(1 - input.washTrading.walletSharePct / 25)
      : null,
  ];
  const organicKnown = organicSignals.filter((value): value is number => value != null);
  const organicValue = organicKnown.length >= 3 ? mean(organicKnown)! * 100 : null;
  const organicConfidence = confidenceFor(input, [input.uniqueBuyersZ != null, input.holderGrowth1h != null, input.concentration.velocity1h != null, input.washTrading.walletSharePct != null], organicSignals);

  const distributionSignals: Array<number | null> = [
    input.concentration.velocity1h != null ? clamp(0.5 + input.concentration.velocity1h * 10) : null,
    input.concentration.gini != null ? clamp(input.concentration.gini) : null,
    input.bundleAnalytics.exitRatio != null ? clamp(input.bundleAnalytics.exitRatio) : null,
    input.bundleAnalytics.bundlePnlPct != null && input.bundleAnalytics.bundlePnlPct > 0 ? clamp(input.bundleAnalytics.bundlePnlPct / 2) : input.bundleAnalytics.bundlePnlPct != null ? 0 : null,
  ];
  const distributionKnown = distributionSignals.filter((value): value is number => value != null);
  const distributionValue = distributionKnown.length >= 2 ? mean(distributionKnown)! * 100 : null;
  const distributionConfidence = confidenceFor(input, [input.concentration.velocity1h != null, input.concentration.gini != null, input.bundleAnalytics.exitRatio != null], distributionSignals);

  const demandSignals: Array<number | null> = [
    input.orderFlow.ofi15m.value != null ? clamp((input.orderFlow.ofi15m.value + 1) / 2) : null,
    input.orderFlow.ofi1h.value != null ? clamp((input.orderFlow.ofi1h.value + 1) / 2) : null,
    input.uniqueBuyersZ != null ? clamp((input.uniqueBuyersZ + 2) / 4) : null,
  ];
  const demandKnown = demandSignals.filter((value): value is number => value != null);
  const demandValue = demandKnown.length >= 2 ? mean(demandKnown)! * 100 : null;
  const demandConfidence = confidenceFor(input, [input.orderFlow.ofi15m.value != null, input.orderFlow.ofi1h.value != null, input.uniqueBuyersZ != null], demandSignals);

  const narrativeSignal = finite(input.narrativeSignal01) ? clamp(input.narrativeSignal01!) : null;
  const narrativeConfidence = confidenceFor(input, [narrativeSignal != null], [narrativeSignal]);

  return {
    smartMoneyScore: score(smartValue, smartConfidence, ["Uses only wallets with known win-rate and realized-ratio evidence."]),
    coordinationScoreV2: score(coordinationValue, coordinationConfidence, ["Funding, bundle and wash evidence are kept distinct; no insider claim is inferred."]),
    organicGrowthScore: score(organicValue, organicConfidence, ["Missing evidence never contributes a neutral +50 baseline."]),
    distributionRiskScore: score(distributionValue, distributionConfidence, ["Risk combines concentration and measured coordinated-wallet exit evidence."]),
    demandMomentumScore: score(demandValue, demandConfidence, ["Demand momentum uses covered OFI windows and buyer momentum."]),
    narrativeMomentumScore: score(narrativeSignal != null ? narrativeSignal * 100 : null, narrativeConfidence, ["No narrative score is fabricated from market-flow inputs."]),
  };
}

export function computeUniqueBuyersZ(trades: RawTrade[], nowSec: number, coverageSec: number | null | undefined): number | null {
  if (!finite(coverageSec) || coverageSec < 3_600) return null;
  const bucketSec = 900;
  const counts: number[] = [];
  for (let bucket = 0; bucket < 4; bucket++) {
    const end = nowSec - bucket * bucketSec;
    const start = end - bucketSec;
    const buyers = new Set(trades.filter((trade) => trade.type === "buy" && trade.timestamp >= start && trade.timestamp < end).map((trade) => trade.trader));
    counts.push(buyers.size);
  }
  const current = counts[0];
  const history = counts.slice(1);
  const avg = mean(history);
  const sigma = std(history);
  if (avg == null || sigma == null || sigma < EPS) return null;
  return finiteOrNull((current - avg) / sigma);
}

export function computeVolumeGrowth1h(trades: RawTrade[], nowSec: number, coverageSec: number | null | undefined): number | null {
  if (!finite(coverageSec) || coverageSec < 7_200) return null;
  const volume = (start: number, end: number): number | null => {
    const rows = trades.filter((trade) => trade.timestamp >= start && trade.timestamp < end && (trade.type === "buy" || trade.type === "sell"));
    const comparable = comparableWindowNotionals(rows);
    return comparable ? comparable.rows.reduce((sum, row) => sum + row.amount, 0) : null;
  };
  const current = volume(nowSec - 3_600, nowSec);
  const previous = volume(nowSec - 7_200, nowSec - 3_600);
  return current != null && previous != null && previous > 0 ? finiteOrNull((current - previous) / previous) : null;
}
