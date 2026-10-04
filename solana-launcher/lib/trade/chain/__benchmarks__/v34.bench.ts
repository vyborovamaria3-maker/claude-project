import { describe, expect, it } from "vitest";
import {
  computeBundleAnalyticsV2,
  computeCompositeScores,
  computeConcentrationDynamics,
  computeFundingTree,
  computeOrderFlow,
  computeScoreConfidence,
  computeWalletPerformance,
  computeWashTradingV2,
  detectContradictions,
  detectLifecycleStage,
  priceChangePctWindow,
  type BundleGroupInput,
} from "../quality-v2";
import { WRAPPED_SOL_MINT, type FundingEdge, type HolderAccount, type RawTrade, type WalletTokenHistory } from "../types";

const NOW_SEC = 2_000_000;
const NOW_MS = NOW_SEC * 1000;
const HOLDER_COUNT = 50;
const TRADE_COUNT = 1_600;
const HISTORY_WALLETS = 20;
const TOKENS_PER_HISTORY = 120;

const holders: HolderAccount[] = Array.from({ length: HOLDER_COUNT }, (_, index) => ({
  address: `W${index}`,
  pct: Math.max(0.1, 4 - index * 0.07),
  amount: Math.max(1, 40_000 - index * 600),
}));

const previousHolders: HolderAccount[] = holders.map((row, index) => ({
  ...row,
  pct: Math.max(0.1, row.pct - (index < 10 ? 0.08 : 0)),
}));

const trades: RawTrade[] = Array.from({ length: TRADE_COUNT }, (_, index) => {
  const amountSol = 0.25 + (index % 32) * 0.12;
  const amountTokens = 25 + (index % 41);
  return {
    signature: `S${index}`,
    timestamp: NOW_SEC - 7_199 + Math.floor((index * 7_199) / (TRADE_COUNT - 1)),
    slot: 1_000_000 + index,
    trader: `W${index % HOLDER_COUNT}`,
    type: index % 2 === 0 ? "buy" : "sell",
    amountSol,
    amountTokens,
    priceSol: amountSol / amountTokens,
    quoteMint: WRAPPED_SOL_MINT,
    quoteAmount: amountSol,
    quoteDecimals: 9,
  };
});

const walletHistory = new Map<string, WalletTokenHistory[]>();
for (let walletIndex = 0; walletIndex < HISTORY_WALLETS; walletIndex++) {
  walletHistory.set(`W${walletIndex}`, Array.from({ length: TOKENS_PER_HISTORY }, (_, tokenIndex) => ({
    mint: `M${tokenIndex}`,
    buys: 2,
    sells: 2,
    volumeSol: 4,
    pnlSol: tokenIndex % 3 === 0 ? -0.2 : 0.5,
    pnlPercent: tokenIndex % 3 === 0 ? -5 : 12,
    isFresh: false,
    isWash: false,
    bundleId: null,
    updatedAt: NOW_SEC,
    realizedPnlSol: tokenIndex % 3 === 0 ? -0.1 : 0.3,
    unrealizedPnlSol: tokenIndex % 3 === 0 ? 0 : 0.2,
    tradeCount: 4,
    medianHoldSlots: 100 + (tokenIndex % 15),
  })));
}

const fundingEdges: FundingEdge[] = Array.from({ length: 20 }, (_, index) => ({
  source: `F${index % 4}`,
  target: `W${index}`,
  signature: `FUND${index}`,
  lamports: 1_000_000_000 + index * 10_000_000,
  blockTime: NOW_SEC - 300 + index * 5,
  historyComplete: true,
  confidence: 0.95,
}));

const bundleGroups: BundleGroupInput[] = Array.from({ length: 5 }, (_, index) => ({
  bundleId: `B${index}`,
  wallets: [`W${index * 2}`, `W${index * 2 + 1}`],
  startTs: NOW_SEC - 1_000 + index,
  quoteMint: WRAPPED_SOL_MINT,
  currentSupplyPct: 2 + index,
  classification: index === 0 ? "verified_bundle" : "coordinated_buy_cluster",
  atomicBundleVerified: index === 0,
}));

const suspiciousWallets = new Set(Array.from({ length: 10 }, (_, index) => `W${index}`));
const creatorFundedWallets = new Set(["W0", "W1", "W2"]);

function runV34CpuFixture() {
  const byWallet = new Map<string, RawTrade[]>();
  for (const row of trades) {
    const list = byWallet.get(row.trader) ?? [];
    list.push(row);
    byWallet.set(row.trader, list);
  }
  const walletPerformances = holders.slice(0, HISTORY_WALLETS).map((holder) =>
    computeWalletPerformance(holder.address, walletHistory.get(holder.address) ?? [], byWallet.get(holder.address) ?? []),
  );
  const concentration = computeConcentrationDynamics(
    holders,
    [{ timestamp: NOW_MS - 3_600_000, holders: previousHolders }],
    NOW_MS,
    "percent100",
  );
  const orderFlow = computeOrderFlow(trades, NOW_SEC, 7_200);
  const bundleAnalytics = computeBundleAnalyticsV2(bundleGroups, trades, 18, creatorFundedWallets, true);
  const fundingTree = computeFundingTree(fundingEdges, true, true);
  const washTrading = computeWashTradingV2(trades, suspiciousWallets, HOLDER_COUNT, true, 7_200, NOW_SEC);
  const lifecycle = detectLifecycleStage({
    ageSlots: 8_000,
    uniqueBuyersZ: 1.2,
    holderGrowth1h: 0.08,
    ofi15m: orderFlow.ofi15m.value,
    concentrationVelocity1h: concentration.velocity1h,
    bundlePnlPct: bundleAnalytics.bundlePnlPct,
    liquidityUsd: 125_000,
    volumeGrowth1h: 0.4,
  });
  const priceChangePct15m = priceChangePctWindow(trades, NOW_SEC, 900);
  const contradictions = detectContradictions({
    holderGrowth1h: 0.08,
    uniqueBuyersZ: 1.2,
    volumeGrowth1h: 0.4,
    priceChangePct15m,
    bundlePnlPct: bundleAnalytics.bundlePnlPct,
    bundleExitRatio: bundleAnalytics.exitRatio,
    creatorFundedWallets: creatorFundedWallets.size,
    creatorSoldPct: 0.1,
    creatorSellCoverageComplete: true,
    concentrationVelocity1h: concentration.velocity1h,
    whaleNetFlow1h: orderFlow.whaleNetFlow1h,
    retailNetFlow1h: orderFlow.retailNetFlow1h,
    ofi15m: orderFlow.ofi15m.value,
  });
  const compositeScores = computeCompositeScores({
    walletPerformances,
    bundleAnalytics,
    fundingTree,
    washTrading,
    concentration,
    orderFlow,
    holderGrowth1h: 0.08,
    uniqueBuyersZ: 1.2,
    narrativeSignal01: 0.7,
    tradeCount: trades.length,
    holderCount: holders.length,
  });
  const confidence = computeScoreConfidence({
    tradeCount: trades.length,
    holderCount: holders.length,
    requiredFieldsPresent: 5,
    requiredFieldsTotal: 5,
    signalScores01: [0.7, 0.65, 0.75],
    historicalCalibration: 0.8,
  });
  return { walletPerformances, concentration, orderFlow, bundleAnalytics, fundingTree, washTrading, lifecycle, contradictions, compositeScores, confidence };
}

function numericValues(value: unknown, out: number[] = []): number[] {
  if (typeof value === "number") out.push(value);
  else if (Array.isArray(value)) for (const item of value) numericValues(item, out);
  else if (value && typeof value === "object") for (const item of Object.values(value as Record<string, unknown>)) numericValues(item, out);
  return out;
}

function compositeEntries(output: ReturnType<typeof runV34CpuFixture>) {
  return Object.values(output.compositeScores);
}

describe("Blockchain Analytics V3.4 performance budget", () => {
  it("1. averages under 20ms for 50 holders / 1600 trades / 20x120 histories after warmup", () => {
    for (let i = 0; i < 10; i++) runV34CpuFixture();
    const started = performance.now();
    for (let i = 0; i < 50; i++) runV34CpuFixture();
    const avgMs = (performance.now() - started) / 50;
    console.info(`[v34] avg CPU: ${avgMs.toFixed(3)}ms over 50 warm iterations`);
    expect(avgMs).toBeLessThan(20);
  });

  it("2. emits no NaN or Infinity", () => {
    const output = runV34CpuFixture();
    const invalid = numericValues(output).filter((value) => !Number.isFinite(value));
    expect(invalid.length).toBe(0);
  });

  it("3. keeps every available composite score in [0,100]", () => {
    const output = runV34CpuFixture();
    const values = compositeEntries(output).map((entry) => entry.value).filter((value): value is number => value != null);
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((value) => value >= 0 && value <= 100)).toBe(true);
  });

  it("4. keeps confidence values in [0,1]", () => {
    const output = runV34CpuFixture();
    const values = [output.confidence.value, ...compositeEntries(output).map((entry) => entry.confidence.value)];
    expect(values.every((value) => value >= 0 && value <= 1)).toBe(true);
  });

  it("5. is deterministic for the same immutable input", () => {
    const left = runV34CpuFixture();
    const right = runV34CpuFixture();
    expect(JSON.stringify(left)).toBe(JSON.stringify(right));
  });
});
