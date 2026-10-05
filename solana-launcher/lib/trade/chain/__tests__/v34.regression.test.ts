import { describe, expect, it } from "vitest";
import {
  computeBundleAnalyticsV2,
  computeCompositeScores,
  computeConcentrationDynamics,
  computeHolderGrowth1hFromSeries,
  computeFundingTree,
  computeOrderFlow,
  computeScoreConfidence,
  computeWalletPerformance,
  computeWashTradingV2,
  detectContradictions,
  detectLifecycleStage,
  priceChangePctWindow,
  type BundleGroupInput,
  type CompositeInput,
} from "../quality-v2";
import { exactHolderCount, WRAPPED_SOL_MINT, type FundingEdge, type HolderAccount, type RawTrade, type WalletTokenHistory } from "../types";

const NOW = 2_000_000;
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function trade(overrides: Partial<RawTrade> = {}): RawTrade {
  return {
    signature: overrides.signature ?? "sig",
    timestamp: overrides.timestamp ?? NOW,
    slot: overrides.slot ?? 100,
    trader: overrides.trader ?? "A",
    type: overrides.type ?? "buy",
    amountSol: overrides.amountSol ?? 1,
    amountTokens: overrides.amountTokens ?? 10,
    priceSol: overrides.priceSol ?? 0.1,
    quoteMint: overrides.quoteMint ?? WRAPPED_SOL_MINT,
    quoteAmount: overrides.quoteAmount ?? Math.abs(overrides.amountSol ?? 1),
    quoteDecimals: overrides.quoteDecimals ?? 9,
    quoteUsdValue: overrides.quoteUsdValue,
    fee: overrides.fee,
    jitoTipLamports: overrides.jitoTipLamports,
    source: overrides.source,
  };
}

function tokenHistory(overrides: Partial<WalletTokenHistory> = {}): WalletTokenHistory {
  return {
    mint: overrides.mint ?? "M",
    buys: overrides.buys ?? 1,
    sells: overrides.sells ?? 1,
    volumeSol: overrides.volumeSol ?? 2,
    pnlSol: overrides.pnlSol ?? 1,
    pnlPercent: overrides.pnlPercent ?? 10,
    isFresh: overrides.isFresh ?? false,
    isWash: overrides.isWash ?? false,
    bundleId: overrides.bundleId ?? null,
    updatedAt: overrides.updatedAt ?? NOW,
    realizedPnlSol: overrides.realizedPnlSol,
    unrealizedPnlSol: overrides.unrealizedPnlSol,
    tradeCount: overrides.tradeCount,
    medianHoldSlots: overrides.medianHoldSlots,
  };
}

function holders(values: number[]): HolderAccount[] {
  return values.map((pct, index) => ({ address: `H${index}`, pct, amount: pct * 1_000 }));
}

function verifiedEdge(source: string, target: string, blockTime = NOW): FundingEdge {
  return { source, target, signature: `${source}-${target}`, lamports: 1_000_000_000, blockTime, historyComplete: true, confidence: 0.95 };
}

function emptyCompositeInput(): CompositeInput {
  return {
    walletPerformances: [],
    bundleAnalytics: computeBundleAnalyticsV2([], [], null, new Set(), false),
    fundingTree: computeFundingTree([], false, false),
    washTrading: computeWashTradingV2([], new Set(), 0, false, null),
    concentration: computeConcentrationDynamics([], [], Date.now()),
    orderFlow: computeOrderFlow([], NOW, null),
    holderGrowth1h: null,
    uniqueBuyersZ: null,
    narrativeSignal01: null,
    tradeCount: 0,
    holderCount: 0,
  };
}

describe("Blockchain Analytics V3.4 regressions", () => {
  it("1. keeps unknown wallet realized/unrealized PnL as null", () => {
    const out = computeWalletPerformance("A", [tokenHistory({ realizedPnlSol: undefined, unrealizedPnlSol: undefined })], []);
    expect(out.realizedPnlSol).toBeNull();
    expect(out.unrealizedPnlSol).toBeNull();
    expect(out.realizedRatio).toBeNull();
    expect(out.isSmartMoney).toBeNull();
  });

  it("2. supports simultaneous realized and unrealized PnL", () => {
    const out = computeWalletPerformance("A", [tokenHistory({ realizedPnlSol: 2, unrealizedPnlSol: 3, tradeCount: 30 })], []);
    expect(out.realizedPnlSol).toBe(2);
    expect(out.unrealizedPnlSol).toBe(3);
    expect(out.realizedRatio).toBeCloseTo(0.4, 8);
  });

  it("3. derives holding time from FIFO matched lots instead of first-buy/last-sell span", () => {
    const rows = [
      trade({ signature: "b1", slot: 10, type: "buy", amountTokens: 100 }),
      trade({ signature: "s1", slot: 20, type: "sell", amountTokens: 20 }),
      trade({ signature: "s2", slot: 30, type: "sell", amountTokens: 20 }),
    ];
    const out = computeWalletPerformance("A", [], rows);
    expect(out.medianHoldSlots).toBe(15);
  });

  it("4. rejects stale snapshots as a 1h concentration baseline", () => {
    const nowMs = 2_000_000_000;
    const out = computeConcentrationDynamics(holders([30, 20, 10]), [{ timestamp: nowMs - 2 * 3_600_000, top10Pct: 40 }], nowMs);
    expect(out.top10Share1hAgo).toBeNull();
    expect(out.velocity1h).toBeNull();
  });

  it("5. handles explicit share01 holder scale without a 100x concentration error", () => {
    const nowMs = 2_000_000_000;
    const current: HolderAccount[] = [{ address: "A", pct: 0.5 }, { address: "B", pct: 0.25 }];
    const out = computeConcentrationDynamics(current, [], nowMs, "share01");
    expect(out.top10ShareNow).toBeCloseTo(0.75, 8);
    expect(out.gini).not.toBeNull();
  });

  it("6. returns null OFI when the requested window is not covered", () => {
    const rows = [trade({ timestamp: NOW - 60 }), trade({ timestamp: NOW })];
    const out = computeOrderFlow(rows, NOW, 60);
    expect(out.ofi1h.coverage).toBeCloseTo(60 / 3600, 8);
    expect(out.ofi1h.value).toBeNull();
  });

  it("7. computes custom-quote OFI and preserves quote mint", () => {
    const rows = [
      trade({ signature: "u1", timestamp: NOW - 100, amountSol: 0, quoteMint: USDC, quoteAmount: 9, quoteDecimals: 6, type: "buy" }),
      trade({ signature: "u2", timestamp: NOW - 50, amountSol: 0, quoteMint: USDC, quoteAmount: 3, quoteDecimals: 6, type: "sell" }),
    ];
    const out = computeOrderFlow(rows, NOW, 3_600);
    expect(out.ofi1h.quoteMint).toBe(USDC);
    expect(out.ofi1h.value).toBeCloseTo(0.5, 8);
  });

  it("8. normalizes negative SOL and custom-quote notionals with Math.abs", () => {
    const solRows = [
      trade({ signature: "n1", amountSol: -10, quoteMint: WRAPPED_SOL_MINT, quoteAmount: -10, type: "buy" }),
      trade({ signature: "n2", amountSol: -2, quoteMint: WRAPPED_SOL_MINT, quoteAmount: -2, type: "sell" }),
    ];
    const sol = computeOrderFlow(solRows, NOW, 3_600);
    expect(sol.ofi1h.value).toBeCloseTo(8 / 12, 8);
    const custom = computeOrderFlow([
      trade({ amountSol: 0, quoteMint: USDC, quoteAmount: -10, type: "buy" }),
      trade({ amountSol: 0, quoteMint: USDC, quoteAmount: -2, type: "sell" }),
    ], NOW, 3_600);
    expect(custom.ofi1h.value).toBeCloseTo(8 / 12, 8);
  });

  it("9. distinguishes unavailable bundle evidence from verified empty bundle evidence", () => {
    const unknown = computeBundleAnalyticsV2([], [], null, new Set(), false);
    const empty = computeBundleAnalyticsV2([], [], null, new Set(), true);
    expect(unknown.bundleCount).toBeNull();
    expect(unknown.available).toBe(false);
    expect(empty.bundleCount).toBe(0);
    expect(empty.available).toBe(true);
  });

  it("10. uses token-weighted bundle entry price and does not count a tiny sell as exit", () => {
    const groups: BundleGroupInput[] = [{
      bundleId: "B1", wallets: ["A", "B"], startTs: NOW - 100, quoteMint: USDC,
      currentSupplyPct: 12, classification: "coordinated_buy_cluster", atomicBundleVerified: false,
    }];
    const rows = [
      trade({ signature: "a-buy", trader: "A", type: "buy", amountSol: 0, quoteMint: USDC, quoteAmount: 10, amountTokens: 100, timestamp: NOW - 100 }),
      trade({ signature: "b-buy", trader: "B", type: "buy", amountSol: 0, quoteMint: USDC, quoteAmount: 10, amountTokens: 10, timestamp: NOW - 95 }),
      trade({ signature: "a-tiny", trader: "A", type: "sell", amountSol: 0, quoteMint: USDC, quoteAmount: 0.02, amountTokens: 0.1, timestamp: NOW }),
    ];
    const out = computeBundleAnalyticsV2(groups, rows, 12, new Set(), true);
    expect(out.entryPriceQuote).toBeCloseTo(20 / 110, 8);
    expect(out.exitCount).toBe(0);
    expect(out.exitRatio).toBe(0);
    expect(out.remainingSupplyRatio).toBeGreaterThan(0.99);
  });

  it("11. counts funding leaves from source ∪ target nodes", () => {
    const out = computeFundingTree([verifiedEdge("F", "A"), verifiedEdge("F", "B"), verifiedEdge("F", "C")], true, true);
    expect(out.rootCount).toBe(1);
    expect(out.leafCount).toBe(3);
    expect(out.maxDepth).toBe(1);
  });

  it("12. keeps unavailable funding-tree negatives unknown", () => {
    const out = computeFundingTree([], false, false);
    expect(out.maxDepth).toBeNull();
    expect(out.rootCount).toBeNull();
    expect(out.timingBurst).toBeNull();
  });

  it("13. exposes funding cycles instead of inventing a hierarchy depth", () => {
    const out = computeFundingTree([verifiedEdge("A", "B"), verifiedEdge("B", "A")], true, true);
    expect(out.cycleDetected).toBe(true);
    expect(out.maxDepth).toBeNull();
  });

  it("14. does not call one-way A-buy/B-sell market activity circular wash trading", () => {
    const rows: RawTrade[] = [];
    for (let i = 0; i < 6; i++) {
      rows.push(trade({ signature: `ab${i}`, trader: "A", type: "buy", slot: 100 + i * 10, quoteAmount: 1, amountTokens: 10 }));
      rows.push(trade({ signature: `bs${i}`, trader: "B", type: "sell", slot: 101 + i * 10, quoteAmount: 1, amountTokens: 10 }));
    }
    const out = computeWashTradingV2(rows, new Set(["A", "B"]), 2, true, 3_600);
    expect(out.suspiciousPairs).toBe(0);
    expect(out.circularPatterns).toBe(0);
  });

  it("15. detects repeated reciprocal matched flow with near-zero net exposure", () => {
    const rows: RawTrade[] = [];
    for (let i = 0; i < 3; i++) {
      const base = 100 + i * 20;
      rows.push(trade({ signature: `ab-buy-${i}`, trader: "A", type: "buy", slot: base, quoteAmount: 1, amountTokens: 10 }));
      rows.push(trade({ signature: `ab-sell-${i}`, trader: "B", type: "sell", slot: base + 1, quoteAmount: 1, amountTokens: 10 }));
      rows.push(trade({ signature: `ba-buy-${i}`, trader: "B", type: "buy", slot: base + 5, quoteAmount: 1, amountTokens: 10 }));
      rows.push(trade({ signature: `ba-sell-${i}`, trader: "A", type: "sell", slot: base + 6, quoteAmount: 1, amountTokens: 10 }));
    }
    const out = computeWashTradingV2(rows, new Set(["A", "B"]), 2, true, 3_600);
    expect(out.suspiciousPairs).toBe(1);
    expect(out.circularPatterns).toBe(1);
  });

  it("16. normalizes Benford anomaly score into [0,1]", () => {
    const rows = Array.from({ length: 45 }, (_, i) => trade({ signature: `bf${i}`, quoteAmount: 1 + (i % 9), amountSol: 1 + (i % 9) }));
    const out = computeWashTradingV2(rows, new Set(), 10, true, 3_600);
    expect(out.benfordScore).not.toBeNull();
    expect((out.benfordScore ?? -1) >= 0).toBe(true);
    expect((out.benfordScore ?? 2) <= 1).toBe(true);
  });

  it("17. never treats unknown creator sell evidence as a contradiction", () => {
    const out = detectContradictions({
      holderGrowth1h: null, uniqueBuyersZ: null, volumeGrowth1h: null, priceChangePct15m: null,
      bundlePnlPct: null, bundleExitRatio: null, creatorFundedWallets: 3, creatorSoldPct: null,
      creatorSellCoverageComplete: false, concentrationVelocity1h: null, whaleNetFlow1h: null,
      retailNetFlow1h: null, ofi15m: null,
    });
    expect(out.length).toBe(0);
  });

  it("18. sorts 15m prices chronologically before computing price change", () => {
    const rows = [
      trade({ timestamp: NOW, amountSol: 0, quoteMint: USDC, quoteAmount: 20, amountTokens: 10 }),
      trade({ timestamp: NOW - 600, amountSol: 0, quoteMint: USDC, quoteAmount: 10, amountTokens: 10 }),
      trade({ timestamp: NOW - 300, amountSol: 0, quoteMint: USDC, quoteAmount: 15, amountTokens: 10 }),
    ];
    expect(priceChangePctWindow(rows, NOW, 900)).toBeCloseTo(1, 8);
  });

  it("19. confidence treats identical normalized signals as full agreement even at zero", () => {
    const out = computeScoreConfidence({ tradeCount: 100, holderCount: 50, requiredFieldsPresent: 2, requiredFieldsTotal: 2, signalScores01: [0, 0] });
    expect(out.components.signalAgreement).toBe(1);
    expect(out.value >= 0 && out.value <= 1).toBe(true);
  });

  it("20. composite layer does not fabricate neutral values or narrative evidence", () => {
    const input = emptyCompositeInput();
    const out = computeCompositeScores(input);
    expect(out.smartMoneyScore.value).toBeNull();
    expect(out.organicGrowthScore.value).toBeNull();
    expect(out.demandMomentumScore.value).toBeNull();
    expect(out.narrativeMomentumScore.value).toBeNull();
    expect(out.narrativeMomentumScore.confidence.value >= 0 && out.narrativeMomentumScore.confidence.value <= 1).toBe(true);
    const lifecycle = detectLifecycleStage({ ageSlots: null, uniqueBuyersZ: null, holderGrowth1h: null, ofi15m: null, concentrationVelocity1h: null, bundlePnlPct: null, liquidityUsd: null, volumeGrowth1h: null });
    expect(lifecycle.stage).toBe("uncertain");
  });

  it("21. never mixes USD and SOL units when only some rows have quoteUsdValue", () => {
    const rows = [
      trade({ signature: "usd-sol-1", type: "buy", amountSol: 10, quoteAmount: 10, quoteUsdValue: 1000 }),
      trade({ signature: "usd-sol-2", type: "sell", amountSol: 2, quoteAmount: 2, quoteUsdValue: undefined }),
    ];
    const out = computeOrderFlow(rows, NOW, 3_600);
    expect(out.ofi1h.unit).toBe("sol");
    expect(out.ofi1h.value).toBeCloseTo(8 / 12, 8);
  });

  it("22. ignores transfer rows when measuring SOL market-flow coverage", () => {
    const rows = [
      trade({ signature: "whale-buy", trader: "A", type: "buy", amountSol: 20, quoteAmount: 20 }),
      trade({ signature: "retail-sell", trader: "B", type: "sell", amountSol: 1, quoteAmount: 1 }),
      trade({ signature: "transfer", trader: "C", type: "transfer", amountSol: 0, amountTokens: 50, quoteMint: USDC, quoteAmount: 0 }),
    ];
    const out = computeOrderFlow(rows, NOW, 3_600);
    expect(out.solCoverage1h).toBe(1);
    expect(out.whaleNetFlow1h).toBe(20);
    expect(out.retailNetFlow1h).toBe(-1);
  });

  it("23. attributes bundle liquidation only to wallets with observed bundle entries", () => {
    const groups: BundleGroupInput[] = [{
      bundleId: "B-entry", wallets: ["A", "B"], startTs: NOW - 100, quoteMint: USDC,
      currentSupplyPct: 10, classification: "coordinated_buy_cluster", atomicBundleVerified: false,
    }];
    const rows = [
      trade({ signature: "a-entry", trader: "A", type: "buy", timestamp: NOW - 100, amountSol: 0, quoteMint: USDC, quoteAmount: 10, amountTokens: 10 }),
      trade({ signature: "a-exit", trader: "A", type: "sell", timestamp: NOW - 10, amountSol: 0, quoteMint: USDC, quoteAmount: 5, amountTokens: 5 }),
      trade({ signature: "b-preexisting", trader: "B", type: "sell", timestamp: NOW - 10, amountSol: 0, quoteMint: USDC, quoteAmount: 100, amountTokens: 100 }),
    ];
    const out = computeBundleAnalyticsV2(groups, rows, 10, new Set(), true);
    expect(out.realizedSupplyRatio).toBeCloseTo(0.5, 8);
    expect(out.exitRatio).toBe(0);
  });

  it("24. transfer/unknown rows cannot manufacture near-zero wash exposure", () => {
    const rows: RawTrade[] = [];
    for (let i = 0; i < 3; i++) {
      const base = 100 + i * 20;
      rows.push(trade({ signature: `ab-buy-x-${i}`, trader: "A", type: "buy", slot: base, quoteAmount: 1, amountTokens: 10 }));
      rows.push(trade({ signature: `ab-sell-x-${i}`, trader: "B", type: "sell", slot: base + 1, quoteAmount: 1, amountTokens: 10 }));
      rows.push(trade({ signature: `ba-buy-x-${i}`, trader: "B", type: "buy", slot: base + 5, quoteAmount: 1, amountTokens: 10 }));
      rows.push(trade({ signature: `ba-sell-x-${i}`, trader: "A", type: "sell", slot: base + 6, quoteAmount: 1, amountTokens: 1 }));
    }
    rows.push(trade({ signature: "noise-transfer", trader: "A", type: "transfer", slot: 200, quoteAmount: 0, amountTokens: 500 }));
    const out = computeWashTradingV2(rows, new Set(["A", "B"]), 2, true, 3_600, NOW);
    expect(out.suspiciousPairs).toBe(0);
  });

  it("25. wash wallet share uses only suspicious wallets actually observed trading", () => {
    const rows = [trade({ trader: "A", type: "buy" }), trade({ trader: "B", type: "sell" })];
    const out = computeWashTradingV2(rows, new Set(["A", "B", "ghost-1", "ghost-2"]), 2, true, 3_600, NOW);
    expect(out.walletCount).toBe(2);
    expect(out.walletSharePct).toBe(100);
  });

  it("26. does not emit a current wash volume/price mismatch from stale trades", () => {
    const rows = Array.from({ length: 4 }, (_, index) => trade({
      signature: `stale-${index}`,
      timestamp: NOW - 4_000 + index * 100,
      type: index % 2 === 0 ? "buy" : "sell",
      amountSol: 30,
      quoteAmount: 30,
      amountTokens: 300,
    }));
    const out = computeWashTradingV2(rows, new Set(["A"]), 1, true, 3_600, NOW);
    expect(out.volumePriceMismatch).toBeNull();
  });

  it("27. suppresses Gini when the holder set is explicitly truncated", () => {
    const current = [
      { address: "A", pct: 60, holderSetComplete: false },
      { address: "B", pct: 20, holderSetComplete: false },
    ] satisfies HolderAccount[];
    const out = computeConcentrationDynamics(current, [], NOW * 1000, "percent100");
    expect(out.gini).toBeNull();
    expect(out.giniCoverageComplete).toBe(false);
  });

  it("28. recognizes legacy negative SOL notional even when quoteMint is absent", () => {
    const buy: RawTrade = { ...trade({ signature: "legacy-neg-buy", type: "buy", amountSol: -10, quoteAmount: -10 }), quoteMint: undefined, quoteAmount: undefined };
    const sell: RawTrade = { ...trade({ signature: "legacy-neg-sell", type: "sell", amountSol: -2, quoteAmount: -2 }), quoteMint: undefined, quoteAmount: undefined };
    const out = computeOrderFlow([buy, sell], NOW, 3_600);
    expect(out.ofi1h.quoteMint).toBe(WRAPPED_SOL_MINT);
    expect(out.ofi1h.value).toBeCloseTo(8 / 12, 8);
  });

  it("29. complete address history makes OFI valid for a newly launched token", () => {
    const rows = [trade({ timestamp: NOW - 120, type: "buy", amountSol: 3, quoteAmount: 3 }), trade({ timestamp: NOW - 30, type: "sell", amountSol: 1, quoteAmount: 1 })];
    const out = computeOrderFlow(rows, NOW, 120, true);
    expect(out.ofi1h.coverage).toBe(1);
    expect(out.ofi1h.value).toBeCloseTo(0.5, 8);
  });

  it("30. anchors holder-growth baselines to analysis time and rejects stale latest snapshots", () => {
    const nowMs = NOW * 1000;
    const stale = computeHolderGrowth1hFromSeries([
      { ts: nowMs - 6 * 3_600_000, holders: 120 },
      { ts: nowMs - 7 * 3_600_000, holders: 100 },
    ], nowMs);
    expect(stale).toBeNull();
    const fresh = computeHolderGrowth1hFromSeries([
      { ts: nowMs - 2 * 60_000, holders: 120 },
      { ts: nowMs - 62 * 60_000, holders: 100 },
    ], nowMs);
    expect(fresh).toBeCloseTo(0.2, 8);
  });


  it("31. keeps a missing custom-quote amount unknown instead of falling back to zero SOL", () => {
    const unknownQuote: RawTrade = {
      ...trade({ signature: "missing-custom", type: "buy", amountSol: 0, quoteMint: USDC, amountTokens: 10 }),
      quoteAmount: undefined,
    };
    const knownQuote = trade({ signature: "known-custom", type: "sell", amountSol: 0, quoteMint: USDC, quoteAmount: 2, amountTokens: 10 });
    const out = computeOrderFlow([unknownQuote, knownQuote], NOW, 3_600);
    expect(out.ofi1h.value).toBeNull();
  });


  it("32. preserves exact total holder count only from complete owner evidence", () => {
    const full: HolderAccount[] = [
      { address: "A", pct: 60, holderSetComplete: false, totalHolderCount: 123 },
      { address: "B", pct: 20, holderSetComplete: false, totalHolderCount: 123 },
    ];
    expect(exactHolderCount(full)).toBe(123);
    const partial: HolderAccount[] = [
      { address: "A", pct: 60, holderSetComplete: false, totalHolderCount: null },
      { address: "B", pct: 20, holderSetComplete: false, totalHolderCount: null },
    ];
    expect(exactHolderCount(partial)).toBeNull();
  });

});
