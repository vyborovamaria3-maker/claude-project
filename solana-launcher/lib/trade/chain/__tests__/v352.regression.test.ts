import { describe, expect, it } from "vitest";
import {
  computeBundleAnalyticsV2,
  computeCompositeScores,
  computeConcentrationDynamics,
  computeFundingTree,
  computeOrderFlow,
  computeWashTradingV2,
  type CompositeInput,
} from "../quality-v2";
import { WRAPPED_SOL_MINT, type RawTrade } from "../types";

const NOW = 2_000_000;
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function trade(overrides: Partial<RawTrade>): RawTrade {
  return {
    signature: overrides.signature ?? "sig",
    timestamp: overrides.timestamp ?? NOW,
    slot: overrides.slot ?? 100,
    trader: overrides.trader ?? "A",
    type: overrides.type ?? "buy",
    amountSol: overrides.amountSol ?? 0,
    amountTokens: overrides.amountTokens ?? 10,
    priceSol: overrides.priceSol ?? 0,
    quoteMint: overrides.quoteMint,
    quoteAmount: overrides.quoteAmount,
    quoteDecimals: overrides.quoteDecimals,
    quoteUsdValue: overrides.quoteUsdValue,
  };
}

function emptyComposite(): CompositeInput {
  return {
    walletPerformances: [],
    bundleAnalytics: computeBundleAnalyticsV2([], [], null, new Set(), false),
    fundingTree: computeFundingTree([], false, false),
    washTrading: computeWashTradingV2([], new Set(), 0, false, null),
    concentration: computeConcentrationDynamics([], [], NOW * 1000),
    orderFlow: computeOrderFlow([], NOW, null),
    holderGrowth1h: null,
    uniqueBuyersZ: null,
    tradeCount: 0,
    holderCount: 0,
  };
}

describe("Blockchain Analytics V3.5.2 regressions", () => {
  it("keeps wash price-range math in USD when USD notionals span quote assets", () => {
    const rows = [
      trade({ signature: "sol", timestamp: NOW - 60, type: "buy", quoteMint: WRAPPED_SOL_MINT, quoteAmount: 60, amountSol: 60, quoteUsdValue: 6000, amountTokens: 600 }),
      trade({ signature: "usdc", timestamp: NOW - 30, type: "sell", quoteMint: USDC, quoteAmount: 6000, quoteUsdValue: 6000, amountTokens: 600 }),
    ];
    const out = computeWashTradingV2(rows, new Set(["A"]), 1, true, 3600, NOW);
    expect(out.volumePriceMismatch).toBe(true);
  });

  it("does not turn partial zero findings into negative coordination evidence", () => {
    const input = emptyComposite();
    input.bundleAnalytics = { ...input.bundleAnalytics, available: true, bundleCount: 0, atomicBundleVerifiedCount: 0 };
    input.fundingTree = { ...input.fundingTree, available: true, timingBurst: false, coverage: 0.5 };
    input.washTrading = { ...input.washTrading, available: true, suspiciousPairs: 0, walletSharePct: 0 };
    expect(computeCompositeScores(input).coordinationScoreV2.value).toBeNull();

    input.bundleEvidenceComplete = true;
    input.washEvidenceComplete = true;
    input.fundingTree = { ...input.fundingTree, coverage: 1 };
    expect(computeCompositeScores(input).coordinationScoreV2.value).toBe(0);
  });

  it("preserves unknown bundle supply when evidence is available but not complete", () => {
    const out = computeBundleAnalyticsV2([], [], null, new Set(), true);
    expect(out.available).toBe(true);
    expect(out.bundleCount).toBe(0);
    expect(out.currentSupplyPct).toBeNull();
  });


  it("uses the recent wash universe for wallet-share denominator", () => {
    const stale = Array.from({ length: 20 }, (_, i) => trade({
      signature: `old-${i}`, trader: `OLD${i}`, timestamp: NOW - 10_000 - i, type: "buy",
    }));
    const recent = [
      trade({ signature: "a", trader: "A", timestamp: NOW - 20, type: "buy" }),
      trade({ signature: "b", trader: "B", timestamp: NOW - 10, type: "sell" }),
    ];
    const out = computeWashTradingV2([...stale, ...recent], new Set(["A", "B"]), 22, true, 3600, NOW);
    expect(out.walletSharePct).toBe(100);
  });


  it("drops stale reciprocal wash pairs from the current wash window", () => {
    const rows: RawTrade[] = [];
    for (let i = 0; i < 3; i++) {
      const base = 100 + i * 20;
      const ts = NOW - 10_000 + i * 10;
      rows.push(trade({ signature: `stale-ab-buy-${i}`, trader: "A", type: "buy", slot: base, timestamp: ts, quoteMint: WRAPPED_SOL_MINT, quoteAmount: 1, amountSol: 1, amountTokens: 10 }));
      rows.push(trade({ signature: `stale-ab-sell-${i}`, trader: "B", type: "sell", slot: base + 1, timestamp: ts + 1, quoteMint: WRAPPED_SOL_MINT, quoteAmount: 1, amountSol: 1, amountTokens: 10 }));
      rows.push(trade({ signature: `stale-ba-buy-${i}`, trader: "B", type: "buy", slot: base + 5, timestamp: ts + 2, quoteMint: WRAPPED_SOL_MINT, quoteAmount: 1, amountSol: 1, amountTokens: 10 }));
      rows.push(trade({ signature: `stale-ba-sell-${i}`, trader: "A", type: "sell", slot: base + 6, timestamp: ts + 3, quoteMint: WRAPPED_SOL_MINT, quoteAmount: 1, amountSol: 1, amountTokens: 10 }));
    }
    const out = computeWashTradingV2(rows, new Set(["A", "B"]), 2, true, 20_000, NOW);
    expect(out.suspiciousPairs).toBe(0);
    expect(out.matchedPairEvents).toBe(0);
    expect(out.walletCount).toBe(0);
  });

});
