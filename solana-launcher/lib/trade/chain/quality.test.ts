import { describe, expect, it } from "vitest";
import { analyzeChainQuality, analyzeChainQualityV2, analyzeChainQualityV3, type ChainEvidenceCoverage, type ChainQualityInput } from "./quality";

function evidence(nowMs: number): ChainEvidenceCoverage {
  const full = (source: string) => ({ source, available: true, complete: true, fetchedAt: nowMs, coveragePct: 100 });
  const trade = (source: string) => ({
    ...full(source),
    launchSlot: 100,
    launchBlockTime: Math.floor(nowMs / 1000) - 200,
    earlyWindowMaxSlot: 200,
    oldestRecentTimestamp: Math.floor(nowMs / 1000) - 4_000,
    recentCoverageSec: 4_000,
  });
  return {
    holders: full("fixture:holders"),
    recentTrades: trade("fixture:recent"),
    launchHistory: trade("fixture:launch"),
    walletAge: full("fixture:age"),
    funding: full("fixture:funding"),
    market: full("fixture:market"),
    pump: full("fixture:pump"),
    creatorHistory: { source: "fixture:creator", available: false, complete: false, fetchedAt: nowMs, coveragePct: 0 },
    walletHistory: full("fixture:history"),
  };
}

function fixture(): ChainQualityInput {
  const nowMs = 1_800_000_000_000;
  const nowSec = nowMs / 1000;
  const holders = [
    { address: "A", tokenAccount: "A_ATA", tokenAccounts: ["A_ATA"], pct: 25, ownerResolved: true, source: "fixture" as const, holderSetComplete: true },
    { address: "B", tokenAccount: "B_ATA", tokenAccounts: ["B_ATA"], pct: 20, ownerResolved: true, source: "fixture" as const, holderSetComplete: true },
    { address: "C", tokenAccount: "C_ATA", tokenAccounts: ["C_ATA"], pct: 15, ownerResolved: true, source: "fixture" as const, holderSetComplete: true },
    { address: "D", tokenAccount: "D_ATA", tokenAccounts: ["D_ATA"], pct: 10, ownerResolved: true, source: "fixture" as const, holderSetComplete: true },
    { address: "E", tokenAccount: "E_ATA", tokenAccounts: ["E_ATA"], pct: 8, ownerResolved: true, source: "fixture" as const, holderSetComplete: true },
    { address: "F", tokenAccount: "F_ATA", tokenAccounts: ["F_ATA"], pct: 5, ownerResolved: true, source: "fixture" as const, holderSetComplete: true },
  ];
  const tokenHistory = (mint: string) => ({
    mint, buys: 1, sells: 1, volumeSol: 1, pnlSol: 1, pnlPercent: 10,
    isFresh: false, isWash: false, bundleId: null, updatedAt: 1,
  });
  return {
    mint: "M",
    nowMs,
    supply: 1_000,
    holders,
    trades: [
      { signature: "1", timestamp: nowSec - 100, slot: 100, trader: "A", type: "buy", amountSol: 5, amountTokens: 100, priceSol: 0.05 },
      { signature: "2", timestamp: nowSec - 99, slot: 100, trader: "B", type: "buy", amountSol: 5.1, amountTokens: 100, priceSol: 0.051 },
      { signature: "3", timestamp: nowSec - 98, slot: 101, trader: "C", type: "buy", amountSol: 3, amountTokens: 60, priceSol: 0.05 },
      { signature: "4", timestamp: nowSec - 20, slot: 120, trader: "A", type: "sell", amountSol: 2, amountTokens: 20, priceSol: 0.1 },
      { signature: "5", timestamp: nowSec - 19, slot: 120, trader: "B", type: "sell", amountSol: 2, amountTokens: 20, priceSol: 0.1 },
    ],
    walletStats: holders.map((holder, index) => ({
      address: holder.address,
      firstSeen: nowSec - (index < 3 ? 3_600 : 100_000),
      totalVolumeSol: index < 2 ? 20 : 1,
      totalPnlSol: index < 2 ? 5 : -1,
      tokensTraded: index < 2 ? 5 : 1,
      totalBuys: 4,
      totalSells: 2,
    })),
    walletTokenHistory: {
      A: [tokenHistory("X"), tokenHistory("Y"), tokenHistory("Z")],
      B: [tokenHistory("X"), tokenHistory("Y"), tokenHistory("Z")],
    },
    creator: "A",
    creatorHistory: null,
    fundingEdges: [
      { source: "FUND", target: "A", signature: "fa", lamports: 1e9, blockTime: nowSec - 200, historyComplete: true, confidence: 0.95 },
      { source: "FUND", target: "B", signature: "fb", lamports: 1e9, blockTime: nowSec - 200, historyComplete: true, confidence: 0.95 },
    ],
    fundingCheckedWallets: holders.map((holder) => holder.address),
    fundingGroups: [{ funder: "FUND", wallets: ["A", "B"] }],
    market: {
      dexId: "pumpfun", pairAddress: "POOL", baseTokenAddress: "M", quoteTokenAddress: "SOL",
      quoteSymbol: "SOL", priceUsd: 1, quotePriceUsd: 100, liquidityUsd: 100_000,
      reserveTokens: 50_000, reserveQuote: 500, virtualQuoteReserves: 0, volume24hUsd: 50_000,
      pairCreatedAt: (nowSec - 60) * 1000, ammModel: "constant_product", isCanonicalMigrationPool: true, exitModelVerified: true,
    },
    pump: {
      creator: "A", complete: true, bondingCurve: "BC", associatedBondingCurve: "B_ATA",
      quoteMint: "So11111111111111111111111111111111111111112", quoteDecimals: 9, quoteSymbol: "SOL", quoteIsNativeSol: true,
      virtualQuoteReserves: 30, virtualTokenReserves: 1e9, realQuoteReserves: 10, realTokenReserves: 5e8,
      totalSupply: 1_000, bondingCurveProgressPct: 100, pumpSwapPool: "POOL", createdAt: nowMs - 200_000,
      source: "fixture:pump", virtualSolReserves: 30, realSolReserves: 10, raydiumPool: null,
    },
    history: [{ observedAt: nowMs - 3_700_000, top10Pct: 75, adjustedTop10Pct: 60, fresh24SupplyPct: 25, insiderSupplyPct: 20, bundleSupplyPct: 25, washWalletPct: 2, smartInflowSol: 1, liquidityUsd: 80_000, evidenceCompleteness: 80 }],
    evidence: evidence(nowMs),
  };
}

describe("chain quality analytics", () => {
  it("uses full-supply owner percentages and excludes owner or token-account system addresses", () => {
    const out = analyzeChainQuality(fixture());
    expect(out.concentration.top10Pct).toBe(83);
    expect(out.concentration.excludedKnownSpecialSupplyPct).toBe(45); // creator A + B via associated bonding-curve token account
    expect(out.concentration.adjustedTop10Pct).toBeCloseTo((38 / 55) * 100, 6);
  });

  it("keeps verified funding evidence separate from ownership claims", () => {
    const out = analyzeChainQuality(fixture());
    expect(out.funding.creatorFunderOverlapWallets).toContain("B");
    expect(out.funding.edges).toHaveLength(2);
    expect(out.insiders.ownershipClaim).toBe(false);
    expect(out.insiders.candidateSupplyPct).toBeGreaterThan(0);
  });

  it("anchors snipers/first-blocks to authoritative launch history and keeps inferred coordination separate from atomic bundles", () => {
    const out = analyzeChainQuality(fixture());
    expect(out.snipers.walletCount).toBe(3);
    expect(out.bundles.verifiedBundleCount).toBe(0);
    expect(out.bundles.atomicBundleVerifiedCount).toBe(0);
    expect(out.bundles.highConfidenceClusterCount).toBe(1);
    expect(out.bundles.currentSupplyPct).toBe(45);
    expect(out.bundles.groups[0]?.classification).toBe("high_confidence_coordination");
    expect(out.bundles.groups[0]?.atomicBundleVerified).toBe(false);
    expect(out.firstBlocks[0]?.creatorRelatedSupplyPct).toBe(45);
    expect(out.coordinatedSelling.groups).toBeGreaterThanOrEqual(1);
  });

  it("does not promote timing-only coordinated buys into verified bundles", () => {
    const input = fixture();
    input.fundingEdges = [];
    input.fundingCheckedWallets = [];
    input.fundingGroups = [];
    input.evidence.funding = { source: "none", available: false, complete: false, fetchedAt: input.nowMs, coveragePct: 0 };
    const out = analyzeChainQuality(input);
    expect(out.bundles.heuristicClusterCount).toBeGreaterThan(0);
    expect(out.bundles.verifiedBundleCount).toBe(0);
    expect(out.bundles.currentSupplyPct).toBeNull();
    expect(out.bundles.coordinatedClusterSupplyPct).toBe(45);
  });

  it("supports partial authoritative launch coverage without inventing larger windows", () => {
    const input = fixture();
    input.evidence.launchHistory.complete = false;
    input.evidence.launchHistory.earlyWindowMaxSlot = 109;
    const out = analyzeChainQuality(input);
    expect(out.firstBlocks.find((row) => row.blocks === 10)?.available).toBe(true);
    expect(out.firstBlocks.find((row) => row.blocks === 20)?.available).toBe(false);
    expect(out.snipers.available).toBe(true);
  });

  it("keeps unknown evidence unknown instead of converting it to good scores", () => {
    const input = fixture();
    input.trades = [];
    input.walletStats = [];
    input.walletTokenHistory = {};
    input.fundingEdges = [];
    input.fundingCheckedWallets = [];
    input.fundingGroups = [];
    const unavailable = { source: "none", available: false, complete: false, fetchedAt: input.nowMs, coveragePct: 0 };
    const noTrade = { ...unavailable, launchSlot: null, launchBlockTime: null, earlyWindowMaxSlot: null, oldestRecentTimestamp: null, recentCoverageSec: null };
    input.evidence.recentTrades = noTrade;
    input.evidence.launchHistory = noTrade;
    input.evidence.walletAge = unavailable;
    input.evidence.funding = unavailable;
    input.evidence.walletHistory = unavailable;
    const out = analyzeChainQuality(input);
    expect(out.walletAge.freshLt24hSupplyPct).toBeNull();
    expect(out.snipers.available).toBe(false);
    expect(out.dimensions.organicDemand.score).toBeNull();
    expect(out.dimensions.organicDemand.confidence).toBe(0);
    expect(out.dimensions.coordinationRisk.score).toBeNull();
    expect(out.dimensions.insiderRisk.score).toBeNull();
  });

  it("rejects stale snapshots as short-window trend baselines", () => {
    const input = fixture();
    input.history = [{ observedAt: input.nowMs - 2 * 3_600_000, top10Pct: 1, adjustedTop10Pct: 1, fresh24SupplyPct: 1, insiderSupplyPct: 1, bundleSupplyPct: 1, washWalletPct: 1, smartInflowSol: 1, liquidityUsd: 1, evidenceCompleteness: 1 }];
    const out = analyzeChainQuality(input);
    expect(out.trends.find((row) => row.windowSec === 300)?.baselineAt).toBeNull();
    expect(out.trends.find((row) => row.windowSec === 1_800)?.baselineAt).toBeNull();
    expect(out.trends.find((row) => row.windowSec === 3_600)?.baselineAt).toBeNull();
  });

  it("only simulates exit liquidity for a verified canonical constant-product pool", () => {
    const good = analyzeChainQuality(fixture());
    expect(good.exitLiquidity.available).toBe(true);
    const input = fixture();
    if (!input.market) throw new Error("fixture market missing");
    input.market.ammModel = "clmm";
    input.market.exitModelVerified = false;
    const out = analyzeChainQuality(input);
    expect(out.exitLiquidity.available).toBe(false);
    expect(out.exitLiquidity.slippageForUsd["10000"]).toBeNull();
  });

  it("keeps 24h smart-money flow unknown when recent history does not cover 24h", () => {
    const input = fixture();
    input.evidence.recentTrades.complete = false;
    const out = analyzeChainQuality(input);
    expect(out.smartMoney.walletCount).toBe(2);
    expect(out.smartMoney.netInflowSol).toBeNull();
  });

  it("keeps post-migration flow unknown when recent history starts after migration", () => {
    const input = fixture();
    input.evidence.recentTrades.complete = false;
    input.evidence.recentTrades.oldestRecentTimestamp = Math.floor(input.nowMs / 1000) - 10;
    input.evidence.recentTrades.recentCoverageSec = 10;
    const out = analyzeChainQuality(input);
    expect(Boolean(out.migration.pairCreatedAt)).toBe(true);
    expect(out.migration.postMigrationBuySol).toBeNull();
    expect(out.migration.postMigrationSellSol).toBeNull();
  });

  it("uses historical cross-token overlap and canonical post-migration flow", () => {
    const input = fixture();
    input.evidence.recentTrades.complete = true;
    const out = analyzeChainQuality(input);
    expect(out.crossToken.pairsWith3PlusSharedTokens).toBe(1);
    expect(out.migration.postMigrationSellSol).toBe(4);
    expect(out.trends.find((row) => row.windowSec === 3_600)?.top10DeltaPp).toBe(8);
  });

  it("preserves the same-slot high-confidence subgroup even when a candidate wallet buys again in the next slot", () => {
    const input = fixture();
    input.trades.push({ signature: "6", timestamp: input.nowMs / 1000 - 97, slot: 101, trader: "A", type: "buy", amountSol: 5, amountTokens: 50, priceSol: 0.1 });
    const out = analyzeChainQuality(input);
    expect(out.bundles.verifiedBundleCount).toBe(0);
    expect(out.bundles.highConfidenceClusterCount).toBe(1);
    expect(out.bundles.groups[0]?.classification).toBe("high_confidence_coordination");
    expect(out.bundles.groups[0]?.wallets).toEqual(expect.arrayContaining(["A", "B"]));
  });

  it("does not call unrelated same-funder early buyers insiders", () => {
    const input = fixture();
    input.creator = "C";
    input.fundingEdges = [
      { source: "OTHER", target: "A", signature: "fa", lamports: 1e9, blockTime: input.nowMs / 1000 - 200, historyComplete: true, confidence: 0.95 },
      { source: "OTHER", target: "B", signature: "fb", lamports: 1e9, blockTime: input.nowMs / 1000 - 200, historyComplete: true, confidence: 0.95 },
      { source: "CREATOR_SOURCE", target: "C", signature: "fc", lamports: 1e9, blockTime: input.nowMs / 1000 - 250, historyComplete: true, confidence: 0.95 },
    ];
    input.fundingCheckedWallets = ["A", "B", "C", "D", "E", "F"];
    input.fundingGroups = [{ funder: "OTHER", wallets: ["A", "B"] }];
    const out = analyzeChainQuality(input);
    expect(out.funding.creatorFunderOverlapWallets).toHaveLength(0);
    expect(out.insiders.candidateSupplyPct).toBe(0);
    expect(out.dimensions.insiderRisk.score).toBe(0);
  });
  it("does not call unrelated same-slot sellers coordinated", () => {
    const input = fixture();
    input.fundingEdges = [];
    input.fundingCheckedWallets = [];
    input.fundingGroups = [];
    input.trades = [
      { signature: "s1", timestamp: input.nowMs / 1000 - 20, slot: 120, trader: "C", type: "sell", amountSol: 2, amountTokens: 20, priceSol: 0.1 },
      { signature: "s2", timestamp: input.nowMs / 1000 - 19, slot: 120, trader: "D", type: "sell", amountSol: 2, amountTokens: 20, priceSol: 0.1 },
    ];
    const out = analyzeChainQuality(input);
    expect(out.coordinatedSelling.groups).toBe(0);
    expect(out.coordinatedSelling.score).toBeNull();
    expect(out.anomalies.some((row) => row.id === "coordinated_selling")).toBe(false);
  });

  it("keeps insider risk unknown when creator funding was not checked, even with strong age/sniper coverage", () => {
    const input = fixture();
    input.fundingEdges = [];
    input.fundingCheckedWallets = ["B", "C", "D", "E", "F"];
    input.fundingGroups = [];
    input.evidence.funding = { source: "partial", available: true, complete: false, fetchedAt: input.nowMs, coveragePct: 100 };
    const out = analyzeChainQuality(input);
    expect(out.insiders.available).toBe(false);
    expect(out.dimensions.insiderRisk.score).toBeNull();
  });

  it("does not turn partial negative funding coverage into a safe insider score", () => {
    const input = fixture();
    input.fundingEdges = [{ source: "CREATOR_SOURCE", target: "A", signature: "fa", lamports: 1e9, blockTime: input.nowMs / 1000 - 200, historyComplete: true, confidence: 0.95 }];
    input.fundingCheckedWallets = ["A", "F"]; // creator + only 30% holder coverage
    input.fundingGroups = [];
    input.evidence.funding = { source: "partial", available: true, complete: true, fetchedAt: input.nowMs, coveragePct: 100 };
    const out = analyzeChainQuality(input);
    expect(out.insiders.candidateCount).toBe(0);
    expect(out.insiders.coveragePct).toBeLessThan(80);
    expect(out.dimensions.insiderRisk.score).toBeNull();
  });

  it("does not coordinate same-slot sellers from different relation groups", () => {
    const input = fixture();
    input.fundingEdges = [
      { source: "F1", target: "A", signature: "fa", lamports: 1e9, blockTime: input.nowMs / 1000 - 200, historyComplete: true, confidence: 0.95 },
      { source: "F1", target: "C", signature: "fc", lamports: 1e9, blockTime: input.nowMs / 1000 - 200, historyComplete: true, confidence: 0.95 },
      { source: "F2", target: "B", signature: "fb", lamports: 1e9, blockTime: input.nowMs / 1000 - 200, historyComplete: true, confidence: 0.95 },
      { source: "F2", target: "D", signature: "fd", lamports: 1e9, blockTime: input.nowMs / 1000 - 200, historyComplete: true, confidence: 0.95 },
    ];
    input.fundingCheckedWallets = ["A", "B", "C", "D"];
    input.fundingGroups = [{ funder: "F1", wallets: ["A", "C"] }, { funder: "F2", wallets: ["B", "D"] }];
    input.trades = [
      { signature: "s1", timestamp: input.nowMs / 1000 - 20, slot: 120, trader: "A", type: "sell", amountSol: 2, amountTokens: 20, priceSol: 0.1 },
      { signature: "s2", timestamp: input.nowMs / 1000 - 19, slot: 120, trader: "B", type: "sell", amountSol: 2, amountTokens: 20, priceSol: 0.1 },
    ];
    const out = analyzeChainQuality(input);
    expect(out.coordinatedSelling.groups).toBe(0);
    expect(out.coordinatedSelling.score).toBe(0);
  });

  it("keeps candidate bundle supply unknown when funding verification is only partially complete", () => {
    const input = fixture();
    input.fundingEdges = [];
    input.fundingCheckedWallets = ["A"];
    input.fundingGroups = [];
    input.evidence.funding = { source: "partial", available: true, complete: false, fetchedAt: input.nowMs, coveragePct: 50 };
    const out = analyzeChainQuality(input);
    expect(out.bundles.heuristicClusterCount).toBeGreaterThan(0);
    expect(out.bundles.verifiedBundleCount).toBe(0);
    expect(out.bundles.currentSupplyPct).toBeNull();
  });

  it("does not treat a missing wallet in a partial holder sample as zero remaining supply", () => {
    const input = fixture();
    input.evidence.holders.complete = false;
    input.trades.push({ signature: "g1", timestamp: input.nowMs / 1000 - 100, slot: 100, trader: "G", type: "buy", amountSol: 1, amountTokens: 10, priceSol: 0.1 });
    const out = analyzeChainQuality(input);
    expect(out.snipers.wallets).toContain("G");
    expect(out.snipers.currentSupplyPct).toBeNull();
    expect(out.snipers.remainingSupplyPct).toBeNull();
  });

  it("excludes unrelated same-slot sell volume from a matched relation subgroup", () => {
    const input = fixture();
    input.fundingEdges = [
      { source: "F1", target: "A", signature: "fa", lamports: 1e9, blockTime: input.nowMs / 1000 - 200, historyComplete: true, confidence: 0.95 },
      { source: "F1", target: "C", signature: "fc", lamports: 1e9, blockTime: input.nowMs / 1000 - 200, historyComplete: true, confidence: 0.95 },
    ];
    input.fundingCheckedWallets = ["A", "B", "C"];
    input.fundingGroups = [{ funder: "F1", wallets: ["A", "C"] }];
    input.trades = [
      { signature: "s1", timestamp: input.nowMs / 1000 - 20, slot: 120, trader: "A", type: "sell", amountSol: 2, amountTokens: 20, priceSol: 0.1 },
      { signature: "s2", timestamp: input.nowMs / 1000 - 19, slot: 120, trader: "B", type: "sell", amountSol: 9, amountTokens: 90, priceSol: 0.1 },
      { signature: "s3", timestamp: input.nowMs / 1000 - 18, slot: 120, trader: "C", type: "sell", amountSol: 2, amountTokens: 20, priceSol: 0.1 },
    ];
    const out = analyzeChainQuality(input);
    expect(out.coordinatedSelling.groups).toBe(1);
    expect(out.coordinatedSelling.wallets).toBe(2);
    expect(out.coordinatedSelling.volumeSol).toBe(4);
  });

  it("keeps negative same-funder metrics unknown when checked supply coverage is low", () => {
    const input = fixture();
    input.fundingEdges = [{ source: "CREATOR_SOURCE", target: "A", signature: "fa", lamports: 1e9, blockTime: input.nowMs / 1000 - 200, historyComplete: true, confidence: 0.95 }];
    input.fundingCheckedWallets = ["A", "F"];
    input.fundingGroups = [];
    input.evidence.funding = { source: "partial", available: true, complete: true, fetchedAt: input.nowMs, coveragePct: 100 };
    const out = analyzeChainQuality(input);
    expect(out.funding.coveragePct).toBeLessThan(80);
    expect(out.funding.sameFunderGroupCount).toBeNull();
    expect(out.funding.sameFunderWalletSupplyPct).toBeNull();
  });

  it("does not convert an incomplete no-cluster trade sample into zero coordinated supply", () => {
    const input = fixture();
    input.trades = [{ signature: "solo", timestamp: input.nowMs / 1000 - 20, slot: 120, trader: "A", type: "buy", amountSol: 1, amountTokens: 10, priceSol: 0.1 }];
    input.evidence.recentTrades.complete = false;
    input.evidence.recentTrades.recentCoverageSec = 900;
    input.fundingCheckedWallets = ["A", "B", "C", "D", "E", "F"];
    input.fundingGroups = [];
    const out = analyzeChainQuality(input);
    expect(out.bundles.heuristicClusterCount).toBe(0);
    expect(out.bundles.currentSupplyPct).toBeNull();
    expect(out.dimensions.organicDemand.score).toBeNull();
  });

  it("does not report sniper cash PnL from truncated trade history", () => {
    const input = fixture();
    input.evidence.recentTrades.complete = false;
    const out = analyzeChainQuality(input);
    expect(out.snipers.available).toBe(true);
    expect(out.snipers.costBasisSol).toBeNull();
    expect(out.snipers.netCashPnlSol).toBeNull();
  });

  it("does not turn low partial holder and age observations into a high distribution-quality score", () => {
    const input = fixture();
    input.creator = null;
    input.pump = null;
    input.holders = [
      { address: "H1", pct: 5, amount: 5, ownerResolved: true, holderSetComplete: false, source: "largest_accounts" },
      { address: "H2", pct: 4, amount: 4, ownerResolved: true, holderSetComplete: false, source: "largest_accounts" },
      { address: "H3", pct: 3, amount: 3, ownerResolved: true, holderSetComplete: false, source: "largest_accounts" },
      { address: "H4", pct: 2, amount: 2, ownerResolved: true, holderSetComplete: false, source: "largest_accounts" },
      { address: "H5", pct: 1, amount: 1, ownerResolved: true, holderSetComplete: false, source: "largest_accounts" },
    ];
    input.walletStats = [{ address: "H1", firstSeen: input.nowMs / 1000 - 10 * 86_400, totalVolumeSol: 0, totalPnlSol: 0, tokensTraded: 0, totalBuys: 0, totalSells: 0 }];
    input.evidence.holders = { source: "rpc:getTokenLargestAccounts-partial", available: true, complete: false, fetchedAt: input.nowMs, coveragePct: 15 };
    input.evidence.walletAge = { source: "partial", available: true, complete: false, fetchedAt: input.nowMs, coveragePct: 20 };
    const out = analyzeChainQuality(input);
    expect(out.concentration.top10Pct).toBe(15);
    expect(out.walletAge.supplyCoveragePct).toBe(5);
    expect(out.dimensions.distributionQuality.score).toBeNull();
  });


  it("keeps flow windows finite and ignores future/transfer noise", () => {
    const input = fixture();
    const nowSec = input.nowMs / 1000;
    input.trades = [
      { signature: "buy", timestamp: nowSec - 60, slot: 100, trader: "A", type: "buy", amountSol: 1, amountTokens: 10, priceSol: 0.1 },
      { signature: "transfer", timestamp: nowSec - 30, slot: 101, trader: "A", type: "transfer", amountSol: 0, amountTokens: 5, priceSol: 0 },
      { signature: "future", timestamp: nowSec + 3600, slot: 999, trader: "A", type: "sell", amountSol: 100, amountTokens: 10, priceSol: 10 },
    ];
    const out = analyzeChainQuality(input);
    const m5 = out.flows.find((row) => row.windowSec === 300)!;
    expect(m5.buysSol).toBe(1);
    expect(m5.sellsSol).toBe(0);
    expect(m5.netFlowSol).toBe(1);
    expect(m5.buySellVolumeRatio).toBeNull();
    expect(m5.buySellTxRatio).toBeNull();
    expect(out.smartMoney.netInflowSol).toBe(1);
  });

  it("does not promote exhausted trade pagination to authoritative inventory PnL without provenance proof", () => {
    const input = fixture();
    const v1 = analyzeChainQuality(input);
    const v2 = analyzeChainQualityV2({ ...input, v1Result: v1 });
    const v3 = analyzeChainQualityV3({
      ...input,
      v1Result: v1,
      v2Result: v2,
      temporalHistory: [],
      walletClusterHistory: [],
    });
    expect(v3.costBasisLedgers.length).toBeGreaterThan(0);
    expect(v3.costBasisLedgers.every((row) => row.costBasisComplete === false)).toBe(true);
    expect(v3.costBasisLedgers.every((row) => row.realizedPnl == null && row.unrealizedPnl == null)).toBe(true);

    const fixtureProven = analyzeChainQualityV3({
      ...input,
      v1Result: v1,
      v2Result: v2,
      temporalHistory: [],
      walletClusterHistory: [],
      tradeLedgerProvenanceComplete: true,
    });
    expect(fixtureProven.costBasisLedgers.some((row) => row.costBasisComplete)).toBe(true);
  });


  it("enforces a single as-of trade boundary across the V1 base layer", () => {
    const input = fixture();
    const nowSec = input.nowMs / 1000;
    input.trades.push({ signature: "future-bundle-a", timestamp: nowSec + 600, slot: 9999, trader: "D", type: "buy", amountSol: 100, amountTokens: 1000, priceSol: 0.1 });
    input.trades.push({ signature: "future-bundle-b", timestamp: nowSec + 601, slot: 9999, trader: "E", type: "buy", amountSol: 100, amountTokens: 1000, priceSol: 0.1 });
    const out = analyzeChainQuality(input);
    expect(out.transactions.observedTrades).toBe(input.trades.length - 2);
    expect(out.bundles.groups.every((group) => group.startTs <= nowSec + 1)).toBe(true);
  });

  it("does not use future funding edges in V2 funding-tree analytics", () => {
    const input = fixture();
    const nowSec = input.nowMs / 1000;
    const v1 = analyzeChainQuality(input);
    input.fundingEdges = [
      ...input.fundingEdges,
      { source: "FUTURE", target: "D", signature: "future-funding", lamports: 1e9, blockTime: nowSec + 600, historyComplete: true, confidence: 0.99 },
    ];
    const v2 = analyzeChainQualityV2({ ...input, v1Result: v1 });
    expect(v2.fundingTree.uniqueFunders).toBe(1);
  });


  it("does not let future funding groups contaminate the V1 as-of graph", () => {
    const input = fixture();
    const nowSec = input.nowMs / 1000;
    input.fundingEdges = [
      ...input.fundingEdges,
      { source: "FUTURE", target: "D", signature: "future-d", lamports: 1e9, blockTime: nowSec + 600, historyComplete: true, confidence: 0.99 },
      { source: "FUTURE", target: "E", signature: "future-e", lamports: 1e9, blockTime: nowSec + 600, historyComplete: true, confidence: 0.99 },
    ];
    input.fundingGroups = [
      ...input.fundingGroups,
      { funder: "FUTURE", wallets: ["D", "E"] },
    ];
    const out = analyzeChainQuality(input);
    expect(out.funding.groups.some((group) => group.funder === "FUTURE")).toBe(false);
    expect(out.funding.edges.some((edge) => edge.source === "FUTURE")).toBe(false);
  });

});
