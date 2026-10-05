import { exactHolderCount, isSolQuotedTrade, tradeQuoteAmount, tradeQuoteMint } from "./types";
import type { FundingEdge, HolderAccount, HolderSnapshot, RawTrade, WalletTokenHistory } from "./types";
import {
  buildTemporalSignalSnapshot,
  computeCostBasisLedgers,
  computeHolderCohortMigration,
  computeLiquidityAdjustedFlow,
  computeOutcomeReplay,
  computeWalletClusterPersistence,
  computeWalletTemporalBehavior,
  type ChainTemporalAnalytics,
  type PersistedClusterHistory,
  type TemporalBundleGroup,
  type TemporalSignalSnapshot,
} from "./quality-v3";
export type { FundingEdge, HolderAccount, HolderSnapshot, RawTrade, WalletTokenHistory } from "./types";
import { aggregateByWallet, calcFifoPnL, detectBundles, detectWashTrading } from "../classify";
import {
  computeBundleAnalyticsV2,
  computeCompositeScores,
  computeConcentrationDynamics,
  computeHolderGrowth1hFromSeries,
  computeFundingTree,
  computeOrderFlow,
  computeScoreConfidence,
  computeUniqueBuyersZ,
  computeVolumeGrowth1h,
  computeWalletPerformance,
  computeWashTradingV2,
  detectContradictions,
  detectLifecycleStage,
  priceChangePctWindow,
  type BundleAnalyticsV2,
  type BundleGroupInput,
  type CompositeScores,
  type ConcentrationDynamics,
  type Contradiction,
  type FundingTree,
  type LifecycleResult,
  type OrderFlowImbalance,
  type ScoreConfidence,
  type WalletPerformance,
  type WashTradingV2,
} from "./quality-v2";

// Per-analysis arrays are immutable inputs. WeakMap memoization avoids rebuilding the
// same holder/wallet indexes across independent metric functions without retaining them
// after the request finishes.
const holderShareCache = new WeakMap<HolderAccount[], Map<string, number>>();
const walletAggregateCache = new WeakMap<RawTrade[], ReturnType<typeof aggregateByWallet>>();
const washFlagCache = new WeakMap<RawTrade[], Map<string, ReturnType<typeof detectWashTrading>>>();

function walletAggregates(trades: RawTrade[]): ReturnType<typeof aggregateByWallet> {
  const cached = walletAggregateCache.get(trades);
  if (cached) return cached;
  const value = aggregateByWallet(trades);
  walletAggregateCache.set(trades, value);
  return value;
}

function washFlags(trades: RawTrade[]): Map<string, ReturnType<typeof detectWashTrading>> {
  const cached = washFlagCache.get(trades);
  if (cached) return cached;
  const flags = new Map<string, ReturnType<typeof detectWashTrading>>();
  for (const [address, aggregate] of walletAggregates(trades)) flags.set(address, detectWashTrading(aggregate));
  washFlagCache.set(trades, flags);
  return flags;
}

export type WalletHistoryStats = {
  address: string;
  firstSeen: number | null;
  totalVolumeSol: number;
  totalPnlSol: number;
  tokensTraded: number;
  totalBuys: number;
  totalSells: number;
};

export type FundingGroup = { funder: string; wallets: string[] };

export type CreatorHistory = {
  address: string;
  totalTokens: number | null;
  migratedCount: number | null;
  migrationRate: number | null;
  reached300kCount: number | null;
  rate300k: number | null;
  totalVolumeSol: number | null;
  avgMcUsd: number | null;
  maxMcUsd: number | null;
  previousTokens: Array<{
    mint: string;
    createdAt: number | null;
    marketCapUsd: number | null;
    athUsd: number | null;
    isMigrated: boolean;
    reached300k: boolean;
  }>;
};

export type AmmModel = "constant_product" | "clmm" | "dlmm" | "bonding_curve" | "unknown";

export type MarketContext = {
  dexId: string | null;
  pairAddress: string | null;
  baseTokenAddress: string | null;
  quoteTokenAddress: string | null;
  quoteSymbol: string | null;
  priceUsd: number | null;
  quotePriceUsd: number | null;
  liquidityUsd: number | null;
  reserveTokens: number | null;
  reserveQuote: number | null;
  /** PumpSwap Pool.virtual_quote_reserves converted to quote-token UI units. */
  virtualQuoteReserves: number | null;
  volume24hUsd: number | null;
  pairCreatedAt: number | null;
  ammModel: AmmModel;
  isCanonicalMigrationPool: boolean;
  exitModelVerified: boolean;
};

export type PumpContext = {
  creator: string | null;
  complete: boolean | null;
  bondingCurve: string | null;
  associatedBondingCurve: string | null;
  quoteMint: string | null;
  quoteDecimals: number | null;
  quoteSymbol: string | null;
  quoteIsNativeSol: boolean | null;
  virtualQuoteReserves: number | null;
  virtualTokenReserves: number | null;
  realQuoteReserves: number | null;
  realTokenReserves: number | null;
  totalSupply: number | null;
  bondingCurveProgressPct: number | null;
  pumpSwapPool: string | null;
  createdAt: number | null;
  source: string;
  /** Backward-compatible aliases; populated only for SOL-paired coins. */
  virtualSolReserves: number | null;
  realSolReserves: number | null;
  /** Legacy field retained for API compatibility. Pump graduation now targets PumpSwap. */
  raydiumPool: string | null;
};

export type EvidenceStatus = {
  source: string;
  available: boolean;
  complete: boolean;
  fetchedAt: number;
  coveragePct: number | null;
  note?: string;
};

export type TradeEvidenceStatus = EvidenceStatus & {
  launchSlot: number | null;
  launchBlockTime: number | null;
  earlyWindowMaxSlot: number | null;
  oldestRecentTimestamp: number | null;
  recentCoverageSec: number | null;
};

export type ChainEvidenceCoverage = {
  holders: EvidenceStatus;
  recentTrades: TradeEvidenceStatus;
  launchHistory: TradeEvidenceStatus;
  walletAge: EvidenceStatus;
  funding: EvidenceStatus;
  market: EvidenceStatus;
  pump: EvidenceStatus;
  creatorHistory: EvidenceStatus;
  walletHistory: EvidenceStatus;
};

export type ChainQualityHistoryPoint = {
  observedAt: number;
  holderCount?: number | null;
  top10Pct: number | null;
  adjustedTop10Pct: number | null;
  fresh24SupplyPct: number | null;
  insiderSupplyPct: number | null;
  bundleSupplyPct: number | null;
  washWalletPct: number | null;
  smartInflowSol: number | null;
  liquidityUsd: number | null;
  evidenceCompleteness: number | null;
};

export type ChainQualityInput = {
  mint: string;
  nowMs: number;
  supply: number | null;
  holders: HolderAccount[];
  trades: RawTrade[];
  walletStats: WalletHistoryStats[];
  walletTokenHistory: Record<string, WalletTokenHistory[]>;
  creator: string | null;
  creatorHistory: CreatorHistory | null;
  fundingEdges: FundingEdge[];
  /** Wallets whose oldest-history funding lookup completed, including negative checks. */
  fundingCheckedWallets: string[];
  fundingGroups: FundingGroup[];
  market: MarketContext | null;
  pump: PumpContext | null;
  history: ChainQualityHistoryPoint[];
  evidence: ChainEvidenceCoverage;
};

export type ConcentrationAnalytics = {
  sampleSize: number;
  /** Exact total owner count only when upstream evidence can prove it. */
  totalHolderCount: number | null;
  sampleCoveragePct: number;
  holderSetComplete: boolean;
  ownerLevel: boolean;
  top1Pct: number | null;
  top3Pct: number | null;
  top5Pct: number | null;
  top10Pct: number | null;
  top20Pct: number | null;
  top50Pct: number | null;
  adjustedTop1Pct: number | null;
  adjustedTop10Pct: number | null;
  adjustedTop20Pct: number | null;
  excludedKnownSpecialSupplyPct: number;
  hhiTopSample: number | null;
  giniTopSample: number | null;
  effectiveHolderCountTopSample: number | null;
};

export type WalletAgeAnalytics = {
  walletsWithAge: number;
  walletCoveragePct: number;
  supplyCoveragePct: number;
  medianAgeHours: number | null;
  freshLt1hCount: number;
  freshLt24hCount: number;
  freshLt7dCount: number;
  freshLt1hSupplyPct: number | null;
  freshLt24hSupplyPct: number | null;
  freshLt7dSupplyPct: number | null;
};

export type FirstBlocksRow = {
  blocks: number;
  available: boolean;
  reason: string | null;
  uniqueBuyers: number | null;
  buyVolumeSol: number | null;
  quoteMint: string | null;
  buyQuoteAmount: number | null;
  grossSupplyBoughtPct: number | null;
  currentSupplyHeldByEarlyBuyersPct: number | null;
  creatorRelatedSupplyPct: number | null;
  freshWalletSupplyPct: number | null;
  verifiedClusterSupplyPct: number | null;
};

export type SniperAnalytics = {
  available: boolean;
  walletCount: number | null;
  currentSupplyPct: number | null;
  costBasisSol: number | null;
  netCashPnlSol: number | null;
  remainingSupplyPct: number | null;
  avgEntrySlotOffset: number | null;
  wallets: string[];
  note: string;
};

export type BundleGroupAnalytics = {
  bundleId: string;
  wallets: string[];
  startTs: number;
  quoteMint: string | null;
  totalQuoteAmount: number | null;
  totalVolumeSol: number | null;
  avgBuySol: number | null;
  currentSupplyPct: number | null;
  sameSlot: boolean;
  classification: "verified_bundle" | "high_confidence_coordination" | "coordinated_buy_cluster";
  /** True only when an explicit atomic bundle identifier/membership was observed. */
  atomicBundleVerified: boolean;
  verificationReasons: string[];
};

export type BundleAnalytics = {
  available: boolean;
  bundleCount: number | null;
  verifiedBundleCount: number | null;
  /** Same-slot coordination corroborated by common funding or Jito-tip evidence, but not atomic bundle proof. */
  highConfidenceClusterCount: number | null;
  atomicBundleVerifiedCount: number | null;
  heuristicClusterCount: number | null;
  walletCount: number | null;
  walletSharePct: number | null;
  currentSupplyPct: number | null;
  coordinatedClusterSupplyPct: number | null;
  largestBundleSupplyPct: number | null;
  realizedPnlSol: number | null;
  sameSlotBundleCount: number | null;
  sellCoordinationScore: number | null;
  groups: BundleGroupAnalytics[];
  note: string;
};

export type FundingAnalytics = {
  available: boolean;
  coveragePct: number;
  verifiedEdgeCount: number | null;
  sameFunderGroupCount: number | null;
  walletsWithVerifiedInitialFunding: number | null;
  sameFunderWalletSupplyPct: number | null;
  creatorInitialFunder: string | null;
  creatorFundingChecked: boolean;
  checkedWallets: string[];
  creatorFunderOverlapWallets: string[];
  edges: FundingEdge[];
  groups: FundingGroup[];
  note: string;
};

export type InsiderCandidate = { address: string; confidence: number; currentSupplyPct: number; evidence: string[] };
export type InsiderAnalytics = {
  available: boolean;
  coveragePct: number;
  candidateCount: number | null;
  candidateSupplyPct: number | null;
  candidates: InsiderCandidate[];
  ownershipClaim: false;
};

export type FlowWindow = {
  windowSec: number;
  complete: boolean;
  buysSol: number | null;
  sellsSol: number | null;
  netFlowSol: number | null;
  buySellVolumeRatio: number | null;
  buySellTxRatio: number | null;
  largeSellCount: number | null;
};

export type CrossTokenAnalytics = {
  walletPairsCompared: number;
  pairsWith3PlusSharedTokens: number;
  maxSharedTokens: number;
  repeatedClusterWallets: string[];
};

export type HolderQualityAnalytics = {
  observedBuyerCount: number | null;
  observedActiveTraderCount: number | null;
  buyersStillInTopHolderSample: number | null;
  buyerRetentionPctTopSample: number | null;
  oneShotBuyerCount: number | null;
  repeatTraderCount: number | null;
  note: string;
};

export type WalletBehaviorFingerprint = {
  address: string;
  currentSupplyPct: number;
  ageHours: number | null;
  historicalTokensTraded: number | null;
  historicalPnlSol: number | null;
  historicalVolumeSol: number | null;
  currentBuySol: number | null;
  currentSellSol: number | null;
  currentNetFlowSol: number | null;
  firstEntrySlotOffset: number | null;
  sniper: boolean | null;
  bundleIds: string[];
  sameFunderGroups: number | null;
  creatorFunderOverlap: boolean | null;
  smartMoney: boolean | null;
  washSuspicious: boolean | null;
  washConfidence: number | null;
};

export type CreatorAnalytics = {
  address: string | null;
  currentSupplyPct: number | null;
  buySol: number | null;
  sellSol: number | null;
  netCashFlowSol: number | null;
  historicalTokens: number | null;
  historicalMigrationRate: number | null;
  historicalReached300kRate: number | null;
  historicalMedianAthUsd: number | null;
};

export type ExitLiquidityAnalytics = {
  available: boolean;
  model: AmmModel | null;
  pairAddress: string | null;
  liquidityUsd: number | null;
  effectiveQuoteSideUsd: number | null;
  slippageForUsd: Record<"500" | "1000" | "5000" | "10000", number | null>;
  slippageForSupplyPct: { pct1: number | null; pct5: number | null; pct10: number | null };
  estimatedUsdOutFor1PctSupply: number | null;
  estimatedUsdOutFor5PctSupply: number | null;
  estimatedUsdOutFor10PctSupply: number | null;
  note: string;
};

export type TransactionQuality = {
  observedTrades: number;
  observedSlots: number;
  avgFeeLamports: number | null;
  medianFeeLamports: number | null;
  jitoTipSol: number | null;
  jitoTxPct: number | null;
  sameSlotBuyPct: number | null;
};

export type StructuralAnomaly = { id: string; severity: "low" | "medium" | "high"; evidence: string };
export type DimensionScore = { score: number | null; confidence: number; evidence: string[] };

export type QualityTrendWindow = {
  windowSec: number;
  baselineAt: number | null;
  baselineAgeErrorSec: number | null;
  top10DeltaPp: number | null;
  adjustedTop10DeltaPp: number | null;
  fresh24SupplyDeltaPp: number | null;
  insiderSupplyDeltaPp: number | null;
  bundleSupplyDeltaPp: number | null;
  washWalletDeltaPp: number | null;
  smartInflowDeltaSol: number | null;
  liquidityDeltaPct: number | null;
};

export type ChainQualityAnalytics = {
  concentration: ConcentrationAnalytics;
  walletAge: WalletAgeAnalytics;
  firstBlocks: FirstBlocksRow[];
  snipers: SniperAnalytics;
  bundles: BundleAnalytics;
  funding: FundingAnalytics;
  insiders: InsiderAnalytics;
  wash: { available: boolean; walletCount: number | null; walletSharePct: number | null; currentSupplyPct: number | null; wallets?: string[] | null };
  smartMoney: { available: boolean; walletCount: number | null; netInflowSol: number | null; currentSupplyPct: number | null };
  flows: FlowWindow[];
  coordinatedSelling: { available: boolean; groups: number | null; wallets: number | null; volumeSol: number | null; score: number | null };
  creator: CreatorAnalytics;
  exitLiquidity: ExitLiquidityAnalytics;
  bondingCurve: PumpContext | null;
  migration: {
    migrated: boolean | null;
    pool: string | null;
    pairCreatedAt: number | null;
    postMigrationBuySol: number | null;
    postMigrationSellSol: number | null;
    postMigrationSellSharePct: number | null;
    creatorPostMigrationSellSol: number | null;
    note: string;
  };
  transactions: TransactionQuality;
  crossToken: CrossTokenAnalytics;
  holderQuality: HolderQualityAnalytics;
  walletProfiles: WalletBehaviorFingerprint[];
  trends: QualityTrendWindow[];
  anomalies: StructuralAnomaly[];
  dimensions: {
    distributionQuality: DimensionScore;
    insiderRisk: DimensionScore;
    creatorRisk: DimensionScore;
    liquidityQuality: DimensionScore;
    exitLiquidity: DimensionScore;
    organicDemand: DimensionScore;
    smartMoneyActivity: DimensionScore;
    coordinationRisk: DimensionScore;
  };
  evidence: ChainEvidenceCoverage;
  evidenceCompletenessPct: number;
};

const clamp = (v: number, min = 0, max = 100) => Math.max(min, Math.min(max, v));
const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const sumKnown = (xs: Array<number | null | undefined>): number | null =>
  xs.every((value): value is number => finite(value)) ? sum(xs) : null;
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const pctText = (value: number | null) => finite(value) ? `${value.toFixed(1)}%` : "unknown";

function holderMap(holders: HolderAccount[]): Map<string, number> {
  const cached = holderShareCache.get(holders);
  if (cached) return cached;
  const value = new Map(holders.map((holder) => [holder.address, holder.pct]));
  holderShareCache.set(holders, value);
  return value;
}

function walletSupplyPct(input: ChainQualityInput, wallets: Iterable<string>): number | null {
  const addresses = [...new Set([...wallets].filter(Boolean))];
  if (!addresses.length) return 0;
  const shares = holderMap(input.holders);
  let total = 0;
  let missing = false;
  for (const address of addresses) {
    if (shares.has(address)) total += shares.get(address)!;
    else missing = true;
  }
  // Absence from a complete owner set means zero. Absence from a Top-N/partial
  // sample is unknown, not zero.
  return missing && !input.evidence.holders.complete ? null : total;
}

function holderMatchesExclusion(holder: HolderAccount, excluded: Set<string>): boolean {
  if (excluded.has(holder.address)) return true;
  if (holder.tokenAccount && excluded.has(holder.tokenAccount)) return true;
  return (holder.tokenAccounts || []).some((account) => excluded.has(account));
}

function concentration(input: ChainQualityInput, excludedAddresses: Set<string>): ConcentrationAnalytics {
  const holders = input.holders;
  const shares = holders.map((holder) => Math.max(0, holder.pct)).sort((a, b) => b - a);
  const top = (n: number): number | null => shares.length ? sum(shares.slice(0, n)) : null;
  const coverage = sum(shares);
  const normalized = coverage > 0 ? shares.map((share) => share / coverage) : [];
  const hhi = normalized.length ? sum(normalized.map((p) => (p * 100) ** 2)) : null;
  let gini: number | null = null;
  if (normalized.length) {
    const asc = [...normalized].sort((a, b) => a - b);
    const n = asc.length;
    const weighted = asc.reduce((acc, value, index) => acc + (index + 1) * value, 0);
    gini = (2 * weighted) / (n * sum(asc)) - (n + 1) / n;
  }
  const sumSq = normalized.length ? sum(normalized.map((p) => p * p)) : 0;
  const excludedSupply = sum(holders.filter((holder) => holderMatchesExclusion(holder, excludedAddresses)).map((holder) => holder.pct));
  const adjustedShares = holders
    .filter((holder) => !holderMatchesExclusion(holder, excludedAddresses))
    .map((holder) => Math.max(0, holder.pct))
    .sort((a, b) => b - a);
  const adjustedDenominator = Math.max(0, 100 - excludedSupply);
  const adjustedTop = (n: number): number | null => {
    if (!adjustedShares.length || adjustedDenominator <= 0) return null;
    return (sum(adjustedShares.slice(0, n)) / adjustedDenominator) * 100;
  };
  const complete = input.evidence.holders.complete;
  const ownerLevel = holders.length === 0 || holders.every((holder) => holder.ownerResolved !== false);
  const totalHolderCount = exactHolderCount(holders) ?? (complete ? holders.length : null);
  return {
    sampleSize: holders.length,
    totalHolderCount,
    sampleCoveragePct: coverage,
    holderSetComplete: complete,
    ownerLevel,
    top1Pct: top(1),
    top3Pct: top(3),
    top5Pct: top(5),
    top10Pct: top(10),
    top20Pct: top(20),
    top50Pct: holders.length >= 50 || complete ? top(50) : null,
    adjustedTop1Pct: adjustedTop(1),
    adjustedTop10Pct: adjustedTop(10),
    adjustedTop20Pct: adjustedTop(20),
    excludedKnownSpecialSupplyPct: excludedSupply,
    hhiTopSample: hhi,
    giniTopSample: gini,
    effectiveHolderCountTopSample: sumSq > 0 ? 1 / sumSq : null,
  };
}

function walletAgeAnalytics(input: ChainQualityInput): WalletAgeAnalytics {
  const nowSec = input.nowMs / 1000;
  const holderPct = holderMap(input.holders);
  const holderAddresses = new Set(input.holders.map((holder) => holder.address));
  const relevantStats = input.walletStats.filter((row) => holderAddresses.has(row.address));
  const withAge = relevantStats.filter((row) => finite(row.firstSeen));
  const agesH = withAge.map((row) => Math.max(0, nowSec - (row.firstSeen as number)) / 3600);
  const inWindow = (hours: number) => withAge.filter((row) => nowSec - (row.firstSeen as number) < hours * 3600);
  const supply = (rows: WalletHistoryStats[]) => sum(rows.map((row) => holderPct.get(row.address) || 0));
  const supplyCoverage = supply(withAge);
  const h1 = inWindow(1);
  const h24 = inWindow(24);
  const d7 = inWindow(24 * 7);
  const hasCoverage = withAge.length > 0;
  return {
    walletsWithAge: withAge.length,
    walletCoveragePct: relevantStats.length ? (withAge.length / relevantStats.length) * 100 : 0,
    supplyCoveragePct: supplyCoverage,
    medianAgeHours: median(agesH),
    freshLt1hCount: h1.length,
    freshLt24hCount: h24.length,
    freshLt7dCount: d7.length,
    freshLt1hSupplyPct: hasCoverage ? supply(h1) : null,
    freshLt24hSupplyPct: hasCoverage ? supply(h24) : null,
    freshLt7dSupplyPct: hasCoverage ? supply(d7) : null,
  };
}

function authoritativeLaunchSlot(input: ChainQualityInput): number | null {
  const evidence = input.evidence.launchHistory;
  // The launch anchor itself is authoritative once it came from oldest-first history.
  // Window completeness is checked separately so a provider that covered only the first
  // 10 slots can still answer 1/3/5/10-block questions without pretending it covered 100.
  return evidence.available && finite(evidence.launchSlot) ? evidence.launchSlot : null;
}

function launchWindowCovered(input: ChainQualityInput, blocks: number): boolean {
  const evidence = input.evidence.launchHistory;
  const launchSlot = authoritativeLaunchSlot(input);
  if (launchSlot == null) return false;
  if (evidence.complete) return true;
  return finite(evidence.earlyWindowMaxSlot) && (evidence.earlyWindowMaxSlot as number) >= launchSlot + Math.max(0, blocks - 1);
}

function firstBlocks(input: ChainQualityInput): FirstBlocksRow[] {
  const windows = [1, 3, 5, 10, 20, 50, 100];
  const launchSlot = authoritativeLaunchSlot(input);
  if (launchSlot == null) {
    return windows.map((blocks) => ({
      blocks,
      available: false,
      reason: "authoritative oldest-first launch anchor unavailable",
      uniqueBuyers: null,
      buyVolumeSol: null,
      quoteMint: null,
      buyQuoteAmount: null,
      grossSupplyBoughtPct: null,
      currentSupplyHeldByEarlyBuyersPct: null,
      creatorRelatedSupplyPct: null,
      freshWalletSupplyPct: null,
      verifiedClusterSupplyPct: null,
    }));
  }

  const buys = input.trades.filter((trade) => trade.type === "buy" && trade.trader && finite(trade.slot));
  const holderPct = holderMap(input.holders);
  const nowSec = input.nowMs / 1000;
  const stats = new Map(input.walletStats.map((row) => [row.address, row]));
  const creatorEdge = input.creator ? input.fundingEdges.find((edge) => edge.target === input.creator && edge.historyComplete) : undefined;
  const creatorRelated = new Set<string>(input.creator ? [input.creator] : []);
  if (creatorEdge) {
    for (const edge of input.fundingEdges) if (edge.historyComplete && edge.source === creatorEdge.source) creatorRelated.add(edge.target);
  }
  const clustered = new Set(input.fundingGroups.flatMap((group) => group.wallets));

  return windows.map((blocks) => {
    if (!launchWindowCovered(input, blocks)) {
      return {
        blocks,
        available: false,
        reason: `launch history does not cover the first ${blocks} slots`,
        uniqueBuyers: null,
        buyVolumeSol: null,
        quoteMint: null,
        buyQuoteAmount: null,
        grossSupplyBoughtPct: null,
        currentSupplyHeldByEarlyBuyersPct: null,
        creatorRelatedSupplyPct: null,
        freshWalletSupplyPct: null,
        verifiedClusterSupplyPct: null,
      };
    }
    const maxSlot = launchSlot + Math.max(0, blocks - 1);
    const rows = buys.filter((trade) => (trade.slot as number) >= launchSlot && (trade.slot as number) <= maxSlot);
    const buyers = [...new Set(rows.map((trade) => trade.trader))];
    const tokens = sum(rows.map((trade) => trade.amountTokens));
    const quoteMints = [...new Set(rows.map(tradeQuoteMint))];
    const solOnly = rows.length > 0 && rows.every(isSolQuotedTrade);
    const oneQuote = quoteMints.length === 1 ? quoteMints[0] : null;
    const fresh = buyers.filter((wallet) => {
      const firstSeen = stats.get(wallet)?.firstSeen;
      return finite(firstSeen) && nowSec - (firstSeen as number) < 24 * 3600;
    });
    return {
      blocks,
      available: true,
      reason: null,
      uniqueBuyers: buyers.length,
      buyVolumeSol: solOnly ? sum(rows.map((trade) => trade.amountSol)) : rows.length === 0 ? 0 : null,
      quoteMint: oneQuote,
      buyQuoteAmount: oneQuote ? sumKnown(rows.map(tradeQuoteAmount)) : rows.length === 0 ? 0 : null,
      grossSupplyBoughtPct: finite(input.supply) && (input.supply as number) > 0 ? (tokens / (input.supply as number)) * 100 : null,
      currentSupplyHeldByEarlyBuyersPct: walletSupplyPct(input, buyers),
      creatorRelatedSupplyPct: walletSupplyPct(input, buyers.filter((wallet) => creatorRelated.has(wallet))),
      freshWalletSupplyPct: input.evidence.walletAge.available ? walletSupplyPct(input, fresh) : null,
      verifiedClusterSupplyPct: input.evidence.funding.available ? walletSupplyPct(input, buyers.filter((wallet) => clustered.has(wallet))) : null,
    };
  });
}

function sniperAnalytics(input: ChainQualityInput): SniperAnalytics {
  const launchSlot = authoritativeLaunchSlot(input);
  if (launchSlot == null || !launchWindowCovered(input, 2)) {
    return {
      available: false,
      walletCount: null,
      currentSupplyPct: null,
      costBasisSol: null,
      netCashPnlSol: null,
      remainingSupplyPct: null,
      avgEntrySlotOffset: null,
      wallets: [],
      note: "Sniper classification disabled without an authoritative launch anchor and coverage through launch+1 slot.",
    };
  }
  const sniperBuys = input.trades.filter((trade) =>
    trade.type === "buy" && trade.trader && finite(trade.slot) && (trade.slot as number) >= launchSlot && (trade.slot as number) <= launchSlot + 1,
  );
  const wallets = [...new Set(sniperBuys.map((trade) => trade.trader))];
  const walletSet = new Set(wallets);
  const holderPct = holderMap(input.holders);
  const nowSec = input.nowMs / 1000;
  const all = input.trades.filter((trade) =>
    walletSet.has(trade.trader)
    && (trade.type === "buy" || trade.type === "sell")
    && finite(trade.timestamp)
    && trade.timestamp <= nowSec + 1
  );
  const solOnly = all.length > 0 && all.every(isSolQuotedTrade);
  const pnlWindowComplete = input.evidence.recentTrades.complete && solOnly;
  const spent = pnlWindowComplete ? sum(all.filter((trade) => trade.type === "buy").map((trade) => trade.amountSol)) : null;
  const received = pnlWindowComplete ? sum(all.filter((trade) => trade.type === "sell").map((trade) => trade.amountSol)) : null;
  const offsets = sniperBuys.map((trade) => (trade.slot as number) - launchSlot);
  const current = walletSupplyPct(input, wallets);
  return {
    available: true,
    walletCount: wallets.length,
    currentSupplyPct: current,
    costBasisSol: spent,
    netCashPnlSol: spent != null && received != null ? received - spent : null,
    remainingSupplyPct: current,
    avgEntrySlotOffset: offsets.length ? sum(offsets) / offsets.length : null,
    wallets,
    note: "Snipers are wallets buying in launch slot or the immediately following slot; launch slot is sourced oldest-first. Cost/P&L fields require exhaustive trade history.",
  };
}

function sellCoordination(
  input: ChainQualityInput,
  relationGroups: Array<Set<string>> = [],
): { available: boolean; groups: number | null; wallets: number | null; volumeSol: number | null; score: number | null } {
  if (!input.evidence.recentTrades.available) return { available: false, groups: null, wallets: null, volumeSol: null, score: null };
  const relatedWallets = new Set(relationGroups.flatMap((group) => [...group]));
  if (relationGroups.length === 0 || relatedWallets.size < 2) {
    return { available: true, groups: 0, wallets: 0, volumeSol: 0, score: null };
  }
  const sells = input.trades
    .filter((trade) => trade.type === "sell" && trade.trader && relatedWallets.has(trade.trader))
    .sort((a, b) => a.timestamp - b.timestamp);
  const used = new Set<string>();
  let groups = 0;
  let volumeSol = 0;
  let allCoordinatedSellsAreSol = true;
  const wallets = new Set<string>();
  for (let i = 0; i < sells.length; i++) {
    const seed = sells[i];
    if (used.has(seed.signature)) continue;
    const cluster = sells.filter((row, index) => index >= i && !used.has(row.signature) && row.trader !== seed.trader && (
      finite(seed.slot) && finite(row.slot) ? seed.slot === row.slot : Math.abs(row.timestamp - seed.timestamp) <= 3
    ));
    if (!cluster.length) continue;
    const rows = [seed, ...cluster];
    const distinct = new Set(rows.map((row) => row.trader));
    if (distinct.size < 2) continue;
    // A global union of related wallets is insufficient: two wallets can belong
    // to different, unrelated funding/bundle groups and merely sell in the same
    // slot. Select the concrete relation group with the largest overlap and only
    // attribute that subgroup's wallets/volume to coordinated selling.
    const matchedGroup = relationGroups
      .map((group) => ({ group, overlap: [...distinct].filter((wallet) => group.has(wallet)).length }))
      .filter((row) => row.overlap >= 2)
      .sort((a, b) => b.overlap - a.overlap)[0]?.group;
    if (!matchedGroup) continue;
    const relatedRows = rows.filter((row) => matchedGroup.has(row.trader));
    if (new Set(relatedRows.map((row) => row.trader)).size < 2) continue;
    groups++;
    for (const row of relatedRows) {
      used.add(row.signature);
      wallets.add(row.trader);
      if (isSolQuotedTrade(row)) volumeSol += row.amountSol;
      else allCoordinatedSellsAreSol = false;
    }
  }
  const complete = input.evidence.recentTrades.complete;
  const allSellsAreSol = sells.every(isSolQuotedTrade);
  const totalSell = allSellsAreSol ? sum(sells.map((trade) => trade.amountSol)) : null;
  const coordinatedShare = complete && totalSell != null && totalSell > 0 && allCoordinatedSellsAreSol ? volumeSol / totalSell : null;
  const scoreValue = complete && coordinatedShare != null ? clamp(groups * 15 + coordinatedShare * 70) : null;
  return {
    available: true,
    groups,
    wallets: wallets.size,
    volumeSol: allCoordinatedSellsAreSol ? volumeSol : null,
    score: scoreValue,
  };
}

function bundleAnalytics(input: ChainQualityInput): BundleAnalytics {
  if (!input.evidence.recentTrades.available && !input.evidence.launchHistory.available) {
    return {
      available: false,
      bundleCount: null,
      verifiedBundleCount: null,
      highConfidenceClusterCount: null,
      atomicBundleVerifiedCount: null,
      heuristicClusterCount: null,
      walletCount: null,
      walletSharePct: null,
      currentSupplyPct: null,
      coordinatedClusterSupplyPct: null,
      largestBundleSupplyPct: null,
      realizedPnlSol: null,
      sameSlotBundleCount: null,
      sellCoordinationScore: null,
      groups: [],
      note: "No transaction evidence available.",
    };
  }
  const { bundles } = detectBundles(input.trades, { windowSec: 5, amountTolerance: 0.08, minWallets: 2 });
  const holderPct = holderMap(input.holders);
  const observedWallets = new Set(
    input.trades.filter((trade) => trade.type === "buy" || trade.type === "sell").map((trade) => trade.trader).filter(Boolean),
  );
  const fundingGroups = input.fundingGroups.map((group) => ({ ...group, set: new Set(group.wallets) }));
  const groupRows: BundleGroupAnalytics[] = bundles.flatMap((bundle): BundleGroupAnalytics[] => {
    // Verify only the exact transactions that created this timing/size candidate cluster.
    // A wider 5-second cluster can legitimately span multiple slots, so verification is
    // performed on same-slot subgroups instead of invalidating the whole candidate.
    const clusterSignatures = new Set(bundle.signatures);
    const candidateRows = input.trades.filter((trade) => trade.type === "buy" && clusterSignatures.has(trade.signature));
    const bySlot = new Map<number, RawTrade[]>();
    for (const row of candidateRows) {
      if (!finite(row.slot)) continue;
      const slot = row.slot as number;
      const rows = bySlot.get(slot) || [];
      rows.push(row);
      bySlot.set(slot, rows);
    }
    const verifiedRowsBySlot = [...bySlot.entries()]
      .map(([slot, rows]) => ({ slot, rows, wallets: [...new Set(rows.map((row) => row.trader))] }))
      .filter((group) => group.wallets.length >= 2)
      .filter((group) => {
        const commonFunder = fundingGroups.some((fundingGroup) => group.wallets.filter((wallet) => fundingGroup.set.has(wallet)).length >= 2);
        const jitoEvidence = group.rows.some((trade) => finite(trade.jitoTipLamports) && (trade.jitoTipLamports as number) > 0);
        return commonFunder || jitoEvidence;
      });

    if (verifiedRowsBySlot.length > 0) {
      return verifiedRowsBySlot.map((verifiedGroup, index) => {
        const rows = verifiedGroup.rows;
        const wallets = verifiedGroup.wallets;
        const commonFunder = fundingGroups.some((fundingGroup) => wallets.filter((wallet) => fundingGroup.set.has(wallet)).length >= 2);
        const jitoEvidence = rows.some((trade) => finite(trade.jitoTipLamports) && (trade.jitoTipLamports as number) > 0);
        const quoteMints = [...new Set(rows.map(tradeQuoteMint))];
        const quoteMint = quoteMints.length === 1 ? quoteMints[0] : null;
        const solOnly = rows.length > 0 && rows.every(isSolQuotedTrade);
        const reasons = ["same Solana slot"];
        if (commonFunder) reasons.push("verified common initial funder");
        if (jitoEvidence) reasons.push("observed Jito tip");
        return {
          bundleId: verifiedRowsBySlot.length === 1 ? bundle.bundleId : `${bundle.bundleId}.${index + 1}`,
          wallets,
          startTs: Math.min(...rows.map((row) => row.timestamp)),
          quoteMint,
          totalQuoteAmount: quoteMint ? sumKnown(rows.map(tradeQuoteAmount)) : null,
          totalVolumeSol: solOnly ? sum(rows.map((trade) => trade.amountSol)) : null,
          avgBuySol: solOnly ? sum(rows.map((trade) => trade.amountSol)) / rows.length : null,
          currentSupplyPct: walletSupplyPct(input, wallets),
          sameSlot: true,
          classification: "high_confidence_coordination" as const,
          atomicBundleVerified: false,
          verificationReasons: reasons,
        };
      });
    }

    const rows = candidateRows;
    const wallets = [...new Set(rows.map((row) => row.trader))];
    const quoteMints = [...new Set(rows.map(tradeQuoteMint))];
    const quoteMint = quoteMints.length === 1 ? quoteMints[0] : null;
    const solOnly = rows.length > 0 && rows.every(isSolQuotedTrade);
    const reasons: string[] = [];
    if (fundingGroups.some((group) => wallets.filter((wallet) => group.set.has(wallet)).length >= 2)) reasons.push("verified common initial funder");
    if (rows.some((trade) => finite(trade.jitoTipLamports) && (trade.jitoTipLamports as number) > 0)) reasons.push("observed Jito tip");
    return [{
      bundleId: bundle.bundleId,
      wallets,
      startTs: bundle.startTs,
      quoteMint,
      totalQuoteAmount: quoteMint ? sumKnown(rows.map(tradeQuoteAmount)) : null,
      totalVolumeSol: solOnly ? sum(rows.map((trade) => trade.amountSol)) : null,
      avgBuySol: solOnly ? sum(rows.map((trade) => trade.amountSol)) / rows.length : null,
      currentSupplyPct: walletSupplyPct(input, wallets),
      sameSlot: false,
      classification: "coordinated_buy_cluster" as const,
      atomicBundleVerified: false,
      verificationReasons: reasons,
    }];
  });
  const atomicVerifiedGroups = groupRows.filter((group) => group.classification === "verified_bundle" && group.atomicBundleVerified);
  const highConfidenceGroups = groupRows.filter((group) => group.classification === "high_confidence_coordination");
  const highConfidenceWallets = new Set(highConfidenceGroups.flatMap((group) => group.wallets));
  const heuristicWallets = new Set(groupRows.flatMap((group) => group.wallets));
  const heuristicSupply = walletSupplyPct(input, heuristicWallets);
  // A positive verification is strong evidence. The absence of a verified group is only
  // negative evidence when there were no timing/size clusters to resolve. If clusters
  // exist but funding/Jito evidence cannot verify them, keep verified-supply metrics unknown.
  const fundingChecked = new Set(input.fundingCheckedWallets);
  const unresolvedVerification = highConfidenceGroups.length === 0 && (
    groupRows.some((group) =>
      group.classification === "coordinated_buy_cluster" && group.wallets.some((wallet) => !fundingChecked.has(wallet))
    ) || (groupRows.length === 0 && !input.evidence.recentTrades.complete)
  );
  const highConfidenceSupply = walletSupplyPct(input, highConfidenceWallets);
  const verifiedSupplyMetric = unresolvedVerification ? null : highConfidenceSupply;
  const highConfidenceGroupSupplies = highConfidenceGroups.map((group) => group.currentSupplyPct).filter((value): value is number => finite(value));
  const largest = highConfidenceGroups.length
    ? (highConfidenceGroupSupplies.length === highConfidenceGroups.length ? Math.max(...highConfidenceGroupSupplies) : null)
    : groupRows.length ? null : 0;
  const nowSec = input.nowMs / 1000;
  const verifiedTrades = input.trades.filter((trade) =>
    highConfidenceWallets.has(trade.trader)
    && (trade.type === "buy" || trade.type === "sell")
    && finite(trade.timestamp)
    && trade.timestamp <= nowSec + 1
  );
  const allVerifiedTradesSol = verifiedTrades.length > 0 && verifiedTrades.every(isSolQuotedTrade);
  let realized: number | null = input.evidence.recentTrades.complete && allVerifiedTradesSol ? 0 : null;
  if (realized != null) {
    const aggs = walletAggregates(input.trades);
    for (const wallet of highConfidenceWallets) {
      const agg = aggs.get(wallet);
      if (agg) realized += calcFifoPnL(agg.trades, 0).realizedSol;
    }
  }
  const coordinated = sellCoordination(input, highConfidenceGroups.map((group) => new Set(group.wallets)));
  return {
    available: true,
    bundleCount: atomicVerifiedGroups.length,
    verifiedBundleCount: atomicVerifiedGroups.length,
    highConfidenceClusterCount: highConfidenceGroups.length,
    atomicBundleVerifiedCount: atomicVerifiedGroups.length,
    heuristicClusterCount: groupRows.length,
    walletCount: unresolvedVerification ? null : highConfidenceWallets.size,
    walletSharePct: unresolvedVerification
      ? null
      : observedWallets.size ? (highConfidenceWallets.size / observedWallets.size) * 100 : input.evidence.recentTrades.complete ? 0 : null,
    currentSupplyPct: verifiedSupplyMetric,
    coordinatedClusterSupplyPct: heuristicSupply,
    largestBundleSupplyPct: largest,
    realizedPnlSol: realized,
    sameSlotBundleCount: atomicVerifiedGroups.filter((group) => group.sameSlot).length,
    sellCoordinationScore: coordinated.score,
    groups: groupRows,
    note: "5-second/similar-size groups are candidate clusters. Same-slot plus common-funder/Jito-tip evidence is high-confidence coordination, not proof of an atomic Jito bundle. 'verified_bundle' is reserved for explicit bundle membership/ID evidence.",
  };
}

function fundingAnalytics(input: ChainQualityInput): FundingAnalytics {
  const holderPct = holderMap(input.holders);
  const status = input.evidence.funding;
  const verifiedEdges = input.fundingEdges.filter((edge) => edge.historyComplete);
  const verifiedTargets = new Set(verifiedEdges.map((edge) => edge.target));
  const checkedWallets = new Set(input.fundingCheckedWallets);
  const groupWallets = new Set(input.fundingGroups.flatMap((group) => group.wallets));
  const creatorFundingChecked = Boolean(input.creator && checkedWallets.has(input.creator));
  const creatorEdge = input.creator && creatorFundingChecked ? verifiedEdges.find((edge) => edge.target === input.creator) : undefined;
  const overlap = creatorEdge ? verifiedEdges.filter((edge) => edge.source === creatorEdge.source && edge.target !== input.creator).map((edge) => edge.target) : [];
  // The provider intentionally checks only a bounded subset of holders. Report
  // coverage against token supply represented by those checked holders, not just
  // "100% of the requested top-8 calls succeeded".
  const checkedHolderSupplyPct = walletSupplyPct(input, [...checkedWallets].filter((wallet) => holderPct.has(wallet))) ?? 0;
  const coveragePct = status.available ? Math.min(status.coveragePct ?? 0, checkedHolderSupplyPct) : 0;
  const negativeGroupInferenceAllowed = coveragePct >= 80;
  const sameFunderGroupCount = !status.available
    ? null
    : input.fundingGroups.length > 0 ? input.fundingGroups.length : negativeGroupInferenceAllowed ? 0 : null;
  const sameFunderWalletSupplyPct = !status.available
    ? null
    : groupWallets.size > 0 ? walletSupplyPct(input, groupWallets) : negativeGroupInferenceAllowed ? 0 : null;
  return {
    available: status.available,
    coveragePct,
    verifiedEdgeCount: status.available ? verifiedEdges.length : null,
    sameFunderGroupCount,
    walletsWithVerifiedInitialFunding: status.available ? verifiedTargets.size : null,
    sameFunderWalletSupplyPct,
    creatorInitialFunder: creatorEdge?.source || null,
    creatorFundingChecked,
    checkedWallets: [...checkedWallets],
    creatorFunderOverlapWallets: [...new Set(overlap)],
    edges: verifiedEdges,
    groups: input.fundingGroups,
    note: "Verified same-funder links are transfer-graph evidence only; negative insider inference is limited by checked-holder supply coverage.",
  };
}

function insiderAnalytics(
  input: ChainQualityInput,
  snipers: SniperAnalytics,
  funding: FundingAnalytics,
  ages: WalletAgeAnalytics,
): InsiderAnalytics {
  // Creator-linked funding is the gating evidence for this detector. Sniper and
  // wallet-age signals can strengthen a positive candidate, but they cannot turn
  // missing creator-funding evidence into a negative ("safe") insider result.
  const coveragePct = funding.creatorFundingChecked ? Math.min(100, funding.coveragePct) : 0;
  const available = funding.available && funding.creatorFundingChecked;
  if (!available) return { available: false, coveragePct: 0, candidateCount: null, candidateSupplyPct: null, candidates: [], ownershipClaim: false };
  const holderPct = holderMap(input.holders);
  const sniperSet = new Set(snipers.wallets);
  const sameFunderSets = input.fundingGroups.map((group) => new Set(group.wallets));
  const creatorOverlap = new Set(funding.creatorFunderOverlapWallets);
  const stats = new Map(input.walletStats.map((row) => [row.address, row]));
  const nowSec = input.nowMs / 1000;
  const candidates: InsiderCandidate[] = [];
  for (const holder of input.holders) {
    // Creator/dev risk is modeled separately. Insider candidates are *other*
    // wallets with a verified creator-linked funding edge. A same-funder group
    // that does not overlap the creator is coordination/Sybil evidence, not
    // insider evidence.
    if (input.creator && holder.address === input.creator) continue;
    const linkedToCreator = creatorOverlap.has(holder.address);
    if (!linkedToCreator) continue;

    let confidence = 55;
    const evidence: string[] = ["verified same initial funder as creator"];
    if (sameFunderSets.some((group) => group.has(holder.address))) {
      confidence += 15;
      evidence.push("member of creator-linked same-initial-funder group");
    }
    if (sniperSet.has(holder.address)) {
      confidence += 20;
      evidence.push("entered in authoritative launch-slot window");
    }
    const firstSeen = stats.get(holder.address)?.firstSeen;
    if (finite(firstSeen) && nowSec - (firstSeen as number) < 24 * 3600) {
      confidence += 10;
      evidence.push("wallet first-seen <24h");
    }
    confidence = clamp(confidence);
    candidates.push({ address: holder.address, confidence, currentSupplyPct: holderPct.get(holder.address) || 0, evidence });
  }
  candidates.sort((a, b) => b.confidence - a.confidence || b.currentSupplyPct - a.currentSupplyPct);
  return {
    available: true,
    coveragePct,
    candidateCount: candidates.length,
    candidateSupplyPct: sum(candidates.map((candidate) => candidate.currentSupplyPct)),
    candidates,
    ownershipClaim: false,
  };
}

function washAnalytics(input: ChainQualityInput): ChainQualityAnalytics["wash"] {
  if (!input.evidence.recentTrades.available) return { available: false, walletCount: null, walletSharePct: null, currentSupplyPct: null, wallets: null };
  const aggs = walletAggregates(input.trades);
  const flags = washFlags(input.trades);
  const wallets = [...flags.entries()].filter(([, flag]) => flag.isSuspicious).map(([address]) => address);
  return {
    available: true,
    walletCount: wallets.length,
    walletSharePct: aggs.size ? (wallets.length / aggs.size) * 100 : input.evidence.recentTrades.complete ? 0 : null,
    currentSupplyPct: walletSupplyPct(input, wallets),
    wallets,
  };
}

function smartMoney(input: ChainQualityInput): ChainQualityAnalytics["smartMoney"] {
  if (!input.evidence.walletHistory.available) return { available: false, walletCount: null, netInflowSol: null, currentSupplyPct: null };
  const holderPct = holderMap(input.holders);
  const qualified = new Set(input.walletStats.filter((row) => row.tokensTraded >= 3 && row.totalPnlSol > 0 && row.totalVolumeSol >= 5).map((row) => row.address));
  const nowSec = input.nowMs / 1000;
  const coverageSec = input.evidence.recentTrades.recentCoverageSec;
  const has24hTradeCoverage = input.evidence.recentTrades.complete || (finite(coverageSec) && (coverageSec as number) >= 86_400);
  const current24h = input.trades.filter((trade) =>
    qualified.has(trade.trader)
    && (trade.type === "buy" || trade.type === "sell")
    && finite(trade.timestamp)
    && trade.timestamp >= nowSec - 86_400
    && trade.timestamp <= nowSec + 1
  );
  const solOnly = current24h.every(isSolQuotedTrade);
  const buys = has24hTradeCoverage && solOnly ? sum(current24h.filter((trade) => trade.type === "buy").map((trade) => trade.amountSol)) : null;
  const sells = has24hTradeCoverage && solOnly ? sum(current24h.filter((trade) => trade.type === "sell").map((trade) => trade.amountSol)) : null;
  return {
    available: true,
    walletCount: qualified.size,
    netInflowSol: buys != null && sells != null ? buys - sells : null,
    currentSupplyPct: walletSupplyPct(input, qualified),
  };
}

function flowWindows(input: ChainQualityInput): FlowWindow[] {
  const nowSec = input.nowMs / 1000;
  const coverageSec = input.evidence.recentTrades.recentCoverageSec;
  const allSolSells = input.trades
    .filter((trade) => trade.type === "sell" && finite(trade.timestamp) && trade.timestamp <= nowSec + 1 && isSolQuotedTrade(trade))
    .map((trade) => Math.abs(trade.amountSol))
    .sort((a, b) => a - b);
  const largeThreshold = allSolSells.length ? (allSolSells[Math.floor(allSolSells.length * 0.9)] || Infinity) : Infinity;
  return [300, 900, 3600].map((windowSec) => {
    const complete = input.evidence.recentTrades.complete || (finite(coverageSec) && (coverageSec as number) >= windowSec);
    if (!complete) {
      return { windowSec, complete: false, buysSol: null, sellsSol: null, netFlowSol: null, buySellVolumeRatio: null, buySellTxRatio: null, largeSellCount: null };
    }
    const rows = input.trades.filter((trade) =>
      (trade.type === "buy" || trade.type === "sell")
      && finite(trade.timestamp)
      && trade.timestamp >= nowSec - windowSec
      && trade.timestamp <= nowSec + 1
    );
    const buys = rows.filter((trade) => trade.type === "buy");
    const sells = rows.filter((trade) => trade.type === "sell");
    const solOnly = rows.every(isSolQuotedTrade);
    const buysSol = solOnly ? sum(buys.map((trade) => trade.amountSol)) : null;
    const sellsSol = solOnly ? sum(sells.map((trade) => trade.amountSol)) : null;
    return {
      windowSec,
      complete: true,
      buysSol,
      sellsSol,
      netFlowSol: buysSol != null && sellsSol != null ? buysSol - sellsSol : null,
      // A zero denominator has no finite ratio. Keep it explicitly unavailable instead
      // of returning Infinity, which JSON.stringify silently converts to null.
      buySellVolumeRatio: buysSol != null && sellsSol != null && sellsSol > 0 ? buysSol / sellsSol : null,
      buySellTxRatio: sells.length > 0 ? buys.length / sells.length : null,
      largeSellCount: solOnly ? sells.filter((trade) => trade.amountSol >= largeThreshold).length : null,
    };
  });
}

function creatorAnalytics(input: ChainQualityInput): CreatorAnalytics {
  const creator = input.creator;
  const holderPct = holderMap(input.holders);
  const holderComplete = input.evidence.holders.complete;
  const nowSec = input.nowMs / 1000;
  const trades = creator ? input.trades.filter((trade) =>
    trade.trader === creator
    && (trade.type === "buy" || trade.type === "sell")
    && finite(trade.timestamp)
    && trade.timestamp <= nowSec + 1
  ) : [];
  // Lifetime creator cash-flow is only emitted when the recent-history source is known
  // to be exhaustive. Otherwise a truncated sample can invert the apparent net flow.
  const tradeWindowUsable = input.evidence.recentTrades.complete && trades.every(isSolQuotedTrade);
  const buys = tradeWindowUsable ? sum(trades.filter((trade) => trade.type === "buy").map((trade) => trade.amountSol)) : null;
  const sells = tradeWindowUsable ? sum(trades.filter((trade) => trade.type === "sell").map((trade) => trade.amountSol)) : null;
  const aths = (input.creatorHistory?.previousTokens || []).map((row) => row.athUsd).filter((value): value is number => finite(value));
  return {
    address: creator,
    currentSupplyPct: creator ? (holderPct.has(creator) ? holderPct.get(creator)! : holderComplete ? 0 : null) : null,
    buySol: buys,
    sellSol: sells,
    netCashFlowSol: buys != null && sells != null ? sells - buys : null,
    historicalTokens: input.creatorHistory?.totalTokens ?? null,
    historicalMigrationRate: input.creatorHistory?.migrationRate ?? null,
    historicalReached300kRate: input.creatorHistory?.rate300k ?? null,
    historicalMedianAthUsd: median(aths),
  };
}

function exitLiquidity(input: ChainQualityInput): ExitLiquidityAnalytics {
  const market = input.market;
  if (!market || !market.exitModelVerified || market.ammModel !== "constant_product" || !market.isCanonicalMigrationPool) {
    return {
      available: false,
      model: market?.ammModel ?? null,
      pairAddress: market?.pairAddress ?? null,
      liquidityUsd: market?.liquidityUsd ?? null,
      effectiveQuoteSideUsd: null,
      slippageForUsd: { "500": null, "1000": null, "5000": null, "10000": null },
      slippageForSupplyPct: { pct1: null, pct5: null, pct10: null },
      estimatedUsdOutFor1PctSupply: null,
      estimatedUsdOutFor5PctSupply: null,
      estimatedUsdOutFor10PctSupply: null,
      note: "Exit simulation is disabled unless the canonical migration pool and AMM model are verified.",
    };
  }
  const x = market.reserveTokens;
  let y = market.reserveQuote;
  const quotePriceUsd = market.quotePriceUsd;
  if (finite(y) && finite(market.virtualQuoteReserves)) y = (y as number) + (market.virtualQuoteReserves as number);
  else if (market.isCanonicalMigrationPool) y = null;
  if (!finite(x) || !finite(y) || !finite(quotePriceUsd) || (x as number) <= 0 || (y as number) <= 0 || (quotePriceUsd as number) <= 0) {
    return {
      available: false,
      model: market.ammModel,
      pairAddress: market.pairAddress,
      liquidityUsd: market.liquidityUsd,
      effectiveQuoteSideUsd: null,
      slippageForUsd: { "500": null, "1000": null, "5000": null, "10000": null },
      slippageForSupplyPct: { pct1: null, pct5: null, pct10: null },
      estimatedUsdOutFor1PctSupply: null,
      estimatedUsdOutFor5PctSupply: null,
      estimatedUsdOutFor10PctSupply: null,
      note: "Verified constant-product pool is missing reserve or quote-price data.",
    };
  }
  const tokenReserve = x as number;
  const quoteReserve = y as number;
  const qPriceUsd = quotePriceUsd as number;
  const priceUsd = market.priceUsd;
  const impactForTokenQty = (qty: number): number => (qty / (tokenReserve + qty)) * 100;
  const impactForUsd = (usd: number): number | null => finite(priceUsd) && (priceUsd as number) > 0 ? impactForTokenQty(usd / (priceUsd as number)) : null;
  const usdOutForSupplyPct = (pct: number): number | null => {
    if (!finite(input.supply) || (input.supply as number) <= 0) return null;
    const qty = (pct / 100) * (input.supply as number);
    const quoteOut = quoteReserve * qty / (tokenReserve + qty);
    return quoteOut * qPriceUsd;
  };
  return {
    available: true,
    model: market.ammModel,
    pairAddress: market.pairAddress,
    liquidityUsd: market.liquidityUsd,
    effectiveQuoteSideUsd: quoteReserve * qPriceUsd,
    slippageForUsd: { "500": impactForUsd(500), "1000": impactForUsd(1000), "5000": impactForUsd(5000), "10000": impactForUsd(10000) },
    slippageForSupplyPct: {
      pct1: finite(input.supply) && (input.supply as number) > 0 ? impactForTokenQty((input.supply as number) * 0.01) : null,
      pct5: finite(input.supply) && (input.supply as number) > 0 ? impactForTokenQty((input.supply as number) * 0.05) : null,
      pct10: finite(input.supply) && (input.supply as number) > 0 ? impactForTokenQty((input.supply as number) * 0.10) : null,
    },
    estimatedUsdOutFor1PctSupply: usdOutForSupplyPct(1),
    estimatedUsdOutFor5PctSupply: usdOutForSupplyPct(5),
    estimatedUsdOutFor10PctSupply: usdOutForSupplyPct(10),
    note: "Constant-product exit simulation using the canonical PumpSwap pool and its effective quote reserve (raw vault + decoded Pool.virtual_quote_reserves).",
  };
}

function transactionQuality(input: ChainQualityInput): TransactionQuality {
  const fees = input.trades.map((trade) => trade.fee).filter((value): value is number => finite(value));
  const jito = input.trades.map((trade) => trade.jitoTipLamports).filter((value): value is number => finite(value) && value > 0);
  const slotted = input.trades.filter((trade) => finite(trade.slot));
  const buys = slotted.filter((trade) => trade.type === "buy");
  const slotCounts = new Map<number, Set<string>>();
  for (const buy of buys) {
    const slot = buy.slot as number;
    if (!slotCounts.has(slot)) slotCounts.set(slot, new Set());
    slotCounts.get(slot)!.add(buy.trader);
  }
  const sameSlotBuyers = new Set<string>();
  for (const wallets of slotCounts.values()) if (wallets.size >= 2) for (const wallet of wallets) sameSlotBuyers.add(wallet);
  return {
    observedTrades: input.trades.length,
    observedSlots: new Set(slotted.map((trade) => trade.slot)).size,
    avgFeeLamports: fees.length ? sum(fees) / fees.length : null,
    medianFeeLamports: median(fees),
    jitoTipSol: jito.length ? sum(jito) / 1_000_000_000 : null,
    // Without a configured/verified tip-account set, absence of a tip is not evidence of no Jito usage.
    jitoTxPct: jito.length && input.trades.length ? (jito.length / input.trades.length) * 100 : null,
    sameSlotBuyPct: buys.length ? (sameSlotBuyers.size / new Set(buys.map((trade) => trade.trader)).size) * 100 : null,
  };
}

function crossToken(input: ChainQualityInput): CrossTokenAnalytics {
  const wallets = Object.keys(input.walletTokenHistory);
  const mintSets = new Map(wallets.map((wallet) => [
    wallet,
    new Set((input.walletTokenHistory[wallet] || []).map((row) => row.mint).filter((mint) => mint !== input.mint)),
  ]));
  let pairs = 0;
  let repeated = 0;
  let maxShared = 0;
  const repeatedWallets = new Set<string>();
  for (let i = 0; i < wallets.length; i++) {
    const a = wallets[i];
    const aMints = mintSets.get(a)!;
    for (let j = i + 1; j < wallets.length; j++) {
      const b = wallets[j];
      const bMints = mintSets.get(b)!;
      pairs++;
      let shared = 0;
      const [small, large] = aMints.size <= bMints.size ? [aMints, bMints] : [bMints, aMints];
      for (const mint of small) if (large.has(mint)) shared++;
      maxShared = Math.max(maxShared, shared);
      if (shared >= 3) {
        repeated++;
        repeatedWallets.add(a);
        repeatedWallets.add(b);
      }
    }
  }
  return { walletPairsCompared: pairs, pairsWith3PlusSharedTokens: repeated, maxSharedTokens: maxShared, repeatedClusterWallets: [...repeatedWallets] };
}

function holderQuality(input: ChainQualityInput): HolderQualityAnalytics {
  if (!input.evidence.recentTrades.available) {
    return {
      observedBuyerCount: null,
      observedActiveTraderCount: null,
      buyersStillInTopHolderSample: null,
      buyerRetentionPctTopSample: null,
      oneShotBuyerCount: null,
      repeatTraderCount: null,
      note: "Trade history unavailable.",
    };
  }
  const aggs = walletAggregates(input.trades);
  const buyers = [...aggs.values()].filter((wallet) => wallet.buys > 0);
  const holderSet = new Set(input.holders.map((holder) => holder.address));
  const retained = buyers.filter((wallet) => holderSet.has(wallet.address)).length;
  return {
    observedBuyerCount: buyers.length,
    observedActiveTraderCount: aggs.size,
    buyersStillInTopHolderSample: retained,
    buyerRetentionPctTopSample: buyers.length ? (retained / buyers.length) * 100 : input.evidence.recentTrades.complete ? 0 : null,
    oneShotBuyerCount: buyers.filter((wallet) => wallet.trades.length === 1).length,
    repeatTraderCount: [...aggs.values()].filter((wallet) => wallet.trades.length >= 3).length,
    note: input.evidence.holders.complete
      ? "Retention compares observed buyers with the current owner-level holder set."
      : "Retention is limited by an incomplete holder sample; absence does not prove a full exit.",
  };
}

function walletBehaviorProfiles(
  input: ChainQualityInput,
  snipers: SniperAnalytics,
  bundles: BundleAnalytics,
  funding: FundingAnalytics,
): WalletBehaviorFingerprint[] {
  const nowSec = input.nowMs / 1000;
  const stats = new Map(input.walletStats.map((row) => [row.address, row]));
  const aggs = walletAggregates(input.trades);
  const washByWallet = washFlags(input.trades);
  const sniperSet = new Set(snipers.wallets);
  const creatorOverlap = new Set(funding.creatorFunderOverlapWallets);
  const launchSlot = authoritativeLaunchSlot(input);
  const smart = new Set(input.walletStats.filter((row) => row.tokensTraded >= 3 && row.totalPnlSol > 0 && row.totalVolumeSol >= 5).map((row) => row.address));
  return input.holders.map((holder) => {
    const stat = stats.get(holder.address);
    const agg = aggs.get(holder.address);
    let firstEntrySlot: number | undefined;
    for (const trade of agg?.trades || []) {
      if (trade.type !== "buy" || !finite(trade.slot)) continue;
      const slot = trade.slot as number;
      if (firstEntrySlot == null || slot < firstEntrySlot) firstEntrySlot = slot;
    }
    const wash = washByWallet.get(holder.address) ?? null;
    const walletTrades = agg?.trades || [];
    const solOnly = walletTrades.every(isSolQuotedTrade);
    return {
      address: holder.address,
      currentSupplyPct: holder.pct,
      ageHours: finite(stat?.firstSeen) ? Math.max(0, nowSec - (stat!.firstSeen as number)) / 3600 : null,
      historicalTokensTraded: stat?.tokensTraded ?? null,
      historicalPnlSol: stat?.totalPnlSol ?? null,
      historicalVolumeSol: stat?.totalVolumeSol ?? null,
      currentBuySol: agg && solOnly ? agg.totalSpentSol : null,
      currentSellSol: agg && solOnly ? agg.totalReceivedSol : null,
      currentNetFlowSol: agg && solOnly ? agg.totalSpentSol - agg.totalReceivedSol : null,
      firstEntrySlotOffset: launchSlot != null && finite(firstEntrySlot) ? firstEntrySlot - launchSlot : null,
      sniper: snipers.available ? sniperSet.has(holder.address) : null,
      bundleIds: bundles.groups.filter((group) => group.classification === "verified_bundle" && group.wallets.includes(holder.address)).map((group) => group.bundleId),
      sameFunderGroups: funding.available ? funding.groups.filter((group) => group.wallets.includes(holder.address)).length : null,
      creatorFunderOverlap: funding.available ? creatorOverlap.has(holder.address) : null,
      smartMoney: input.evidence.walletHistory.available ? smart.has(holder.address) : null,
      washSuspicious: wash ? wash.isSuspicious : input.evidence.recentTrades.complete ? false : null,
      washConfidence: wash?.confidence ?? null,
    };
  });
}

function trendWindows(
  input: ChainQualityInput,
  current: {
    top10Pct: number | null;
    adjustedTop10Pct: number | null;
    fresh24SupplyPct: number | null;
    insiderSupplyPct: number | null;
    bundleSupplyPct: number | null;
    washWalletPct: number | null;
    smartInflowSol: number | null;
    liquidityUsd: number | null;
  },
): QualityTrendWindow[] {
  const sorted = [...input.history].sort((a, b) => a.observedAt - b.observedAt);
  const delta = (now: number | null, before: number | null): number | null => finite(now) && finite(before) ? (now as number) - (before as number) : null;
  return [300, 1_800, 3_600, 21_600, 86_400].map((windowSec) => {
    const target = input.nowMs - windowSec * 1000;
    const toleranceMs = Math.max(60_000, windowSec * 1000 * 0.35);
    let base: ChainQualityHistoryPoint | null = null;
    let bestDistance = Infinity;
    for (const row of sorted) {
      const distance = Math.abs(row.observedAt - target);
      if (distance < bestDistance) {
        bestDistance = distance;
        base = row;
      }
    }
    if (!base || bestDistance > toleranceMs) base = null;
    const liquidityDeltaPct = base && finite(current.liquidityUsd) && finite(base.liquidityUsd) && (base.liquidityUsd as number) > 0
      ? (((current.liquidityUsd as number) - (base.liquidityUsd as number)) / (base.liquidityUsd as number)) * 100
      : null;
    return {
      windowSec,
      baselineAt: base?.observedAt ?? null,
      baselineAgeErrorSec: base ? Math.abs(base.observedAt - target) / 1000 : null,
      top10DeltaPp: delta(current.top10Pct, base?.top10Pct ?? null),
      adjustedTop10DeltaPp: delta(current.adjustedTop10Pct, base?.adjustedTop10Pct ?? null),
      fresh24SupplyDeltaPp: delta(current.fresh24SupplyPct, base?.fresh24SupplyPct ?? null),
      insiderSupplyDeltaPp: delta(current.insiderSupplyPct, base?.insiderSupplyPct ?? null),
      bundleSupplyDeltaPp: delta(current.bundleSupplyPct, base?.bundleSupplyPct ?? null),
      washWalletDeltaPp: delta(current.washWalletPct, base?.washWalletPct ?? null),
      smartInflowDeltaSol: delta(current.smartInflowSol, base?.smartInflowSol ?? null),
      liquidityDeltaPct,
    };
  });
}

function migrationAnalytics(input: ChainQualityInput): ChainQualityAnalytics["migration"] {
  const migrated = input.pump?.complete ?? null;
  const pool = input.pump?.pumpSwapPool ?? null;
  const canonical = Boolean(pool && input.market?.pairAddress === pool && input.market?.isCanonicalMigrationPool);
  const pairCreatedAt = canonical ? input.market?.pairCreatedAt ?? null : null;
  if (!canonical || pairCreatedAt == null) {
    return {
      migrated,
      pool,
      pairCreatedAt: null,
      postMigrationBuySol: null,
      postMigrationSellSol: null,
      postMigrationSellSharePct: null,
      creatorPostMigrationSellSol: null,
      note: pool ? "Canonical PumpSwap pool was not matched to market data." : "Canonical PumpSwap pool unavailable; secondary pairs are not used as migration anchors.",
    };
  }
  const cutoffSec = pairCreatedAt > 10_000_000_000 ? pairCreatedAt / 1000 : pairCreatedAt;
  const oldestRecent = input.evidence.recentTrades.oldestRecentTimestamp;
  const historyCoversMigration = input.evidence.recentTrades.complete || (finite(oldestRecent) && (oldestRecent as number) <= cutoffSec);
  if (!historyCoversMigration) {
    return {
      migrated,
      pool,
      pairCreatedAt,
      postMigrationBuySol: null,
      postMigrationSellSol: null,
      postMigrationSellSharePct: null,
      creatorPostMigrationSellSol: null,
      note: "Canonical migration pool matched, but recent transaction history does not reach the migration timestamp.",
    };
  }
  const nowSec = input.nowMs / 1000;
  const rows = input.trades.filter((trade) =>
    (trade.type === "buy" || trade.type === "sell")
    && finite(trade.timestamp)
    && trade.timestamp >= cutoffSec
    && trade.timestamp <= nowSec + 1
  );
  const solOnly = rows.every(isSolQuotedTrade);
  if (!solOnly) {
    return {
      migrated,
      pool,
      pairCreatedAt,
      postMigrationBuySol: null,
      postMigrationSellSol: null,
      postMigrationSellSharePct: null,
      creatorPostMigrationSellSol: null,
      note: "Post-migration trades use a non-SOL quote; SOL-denominated migration flow is intentionally unknown.",
    };
  }
  const buys = sum(rows.filter((trade) => trade.type === "buy").map((trade) => trade.amountSol));
  const sells = sum(rows.filter((trade) => trade.type === "sell").map((trade) => trade.amountSol));
  const creatorSells = input.creator ? sum(rows.filter((trade) => trade.type === "sell" && trade.trader === input.creator).map((trade) => trade.amountSol)) : null;
  return {
    migrated,
    pool,
    pairCreatedAt,
    postMigrationBuySol: buys,
    postMigrationSellSol: sells,
    postMigrationSellSharePct: buys + sells > 0 ? (sells / (buys + sells)) * 100 : 0,
    creatorPostMigrationSellSol: creatorSells,
    note: "Migration flow anchored to the canonical PumpSwap pool only.",
  };
}

function anomalies(
  c: ConcentrationAnalytics,
  ages: WalletAgeAnalytics,
  snipers: SniperAnalytics,
  bundles: BundleAnalytics,
  funding: FundingAnalytics,
  insiders: InsiderAnalytics,
  wash: ChainQualityAnalytics["wash"],
  coordinated: ChainQualityAnalytics["coordinatedSelling"],
): StructuralAnomaly[] {
  const out: StructuralAnomaly[] = [];
  if (finite(c.top10Pct) && c.top10Pct >= 60) out.push({ id: "top10_concentration", severity: "high", evidence: `Top-10 hold ${c.top10Pct.toFixed(1)}% of supply.` });
  if (finite(ages.freshLt24hSupplyPct) && ages.freshLt24hSupplyPct >= 40) out.push({ id: "fresh_wallet_supply", severity: "high", evidence: `Known <24h wallets hold ${ages.freshLt24hSupplyPct.toFixed(1)}% of supply (age coverage ${ages.supplyCoveragePct.toFixed(1)}%).` });
  if (finite(snipers.currentSupplyPct) && snipers.currentSupplyPct >= 20) out.push({ id: "sniper_supply", severity: "high", evidence: `Launch-slot sniper wallets retain ${snipers.currentSupplyPct.toFixed(1)}% of supply.` });
  if (finite(bundles.currentSupplyPct) && bundles.currentSupplyPct >= 20) out.push({ id: "coordinated_buy_supply", severity: "high", evidence: `High-confidence coordinated-buy groups retain ${bundles.currentSupplyPct.toFixed(1)}% of supply; atomic Jito bundle membership is not asserted.` });
  if (finite(funding.sameFunderWalletSupplyPct) && funding.sameFunderWalletSupplyPct >= 20) out.push({ id: "same_funder_supply", severity: "high", evidence: `Verified same-funder groups hold ${funding.sameFunderWalletSupplyPct.toFixed(1)}% of supply.` });
  if (finite(insiders.candidateSupplyPct) && insiders.candidateSupplyPct >= 20) out.push({ id: "insider_candidate_supply", severity: "high", evidence: `Multi-signal insider candidates hold ${insiders.candidateSupplyPct.toFixed(1)}% of supply; this is not an ownership claim.` });
  if (finite(wash.walletSharePct) && wash.walletSharePct >= 10) out.push({ id: "wash_activity", severity: "medium", evidence: `${wash.walletSharePct.toFixed(1)}% of observed trading wallets meet wash heuristics.` });
  if (finite(coordinated.score) && coordinated.score >= 60) out.push({ id: "coordinated_selling", severity: "high", evidence: `Coordinated-sell score ${coordinated.score.toFixed(0)}/100 across ${coordinated.groups ?? 0} groups.` });
  return out;
}

function score(value: number | null, confidence: number, evidence: string[]): DimensionScore {
  return { score: value == null ? null : clamp(value), confidence: value == null ? 0 : clamp(confidence), evidence };
}

function weightedRisk(components: Array<{ value: number | null; weight: number }>): number | null {
  const known = components.filter((component) => finite(component.value));
  if (!known.length) return null;
  const totalWeight = sum(known.map((component) => component.weight));
  return sum(known.map((component) => (component.value as number) * component.weight)) / totalWeight;
}

function dimensions(
  input: ChainQualityInput,
  c: ConcentrationAnalytics,
  ages: WalletAgeAnalytics,
  insiders: InsiderAnalytics,
  creator: CreatorAnalytics,
  exit: ExitLiquidityAnalytics,
  wash: ChainQualityAnalytics["wash"],
  smart: ChainQualityAnalytics["smartMoney"],
  bundles: BundleAnalytics,
  coordinated: ChainQualityAnalytics["coordinatedSelling"],
  flow: FlowWindow[],
): ChainQualityAnalytics["dimensions"] {
  const top10ForScore = c.adjustedTop10Pct ?? c.top10Pct;
  const holderRankingExact = c.holderSetComplete || input.evidence.holders.source.includes("getProgramAccounts-owner-aggregation");
  const walletAgeReliable = ages.supplyCoveragePct >= 80;
  const top10RiskValue = finite(top10ForScore) ? clamp(((top10ForScore as number) - 20) * 1.5) : null;
  const freshRiskValue = finite(ages.freshLt24hSupplyPct) ? clamp((ages.freshLt24hSupplyPct as number) * 0.8) : null;
  let distributionRisk = weightedRisk([
    { value: holderRankingExact ? top10RiskValue : null, weight: 0.7 },
    { value: walletAgeReliable ? freshRiskValue : null, weight: 0.3 },
  ]);
  // Partial sources produce lower bounds, not trustworthy low-risk measurements. They
  // may raise the observed risk floor, but must never make distribution look safer.
  const partialRiskFloors = [
    !holderRankingExact && finite(top10RiskValue) && (top10RiskValue as number) > 0 ? top10RiskValue : null,
    !walletAgeReliable && finite(freshRiskValue) && (freshRiskValue as number) > 0 ? freshRiskValue : null,
  ].filter((value): value is number => finite(value));
  if (partialRiskFloors.length) {
    const floor = Math.max(...partialRiskFloors);
    distributionRisk = distributionRisk == null ? floor : Math.max(distributionRisk, floor);
  }
  const distributionBase = distributionRisk == null ? null : 100 - distributionRisk;

  const insiderRisk = finite(insiders.candidateSupplyPct) && finite(insiders.candidateCount)
    ? clamp((insiders.candidateSupplyPct as number) * 2 + (insiders.candidateCount as number) * 4)
    : null;

  const creatorComponents: Array<{ value: number | null; weight: number }> = [
    { value: finite(creator.currentSupplyPct) ? clamp((creator.currentSupplyPct as number) * 2) : null, weight: 0.45 },
    { value: finite(creator.netCashFlowSol) ? clamp(Math.max(0, creator.netCashFlowSol as number) * 3) : null, weight: 0.3 },
    { value: finite(creator.historicalMigrationRate) ? clamp((1 - (creator.historicalMigrationRate as number)) * 100) : null, weight: 0.25 },
  ];
  const creatorRisk = creator.address ? weightedRisk(creatorComponents) : null;

  const liqScore = exit.liquidityUsd == null ? null : clamp(Math.log10(Math.max(1, exit.liquidityUsd)) * 20 - 20);
  const exit10k = exit.slippageForUsd["10000"];
  const exitScore = exit10k == null ? null : clamp(100 - exit10k * 4);

  const latestFlow = flow.find((row) => row.windowSec === 900);
  // A high organic-demand score is a positive claim, so all major anti-organic
  // dimensions must have enough negative-evidence coverage. Partial observations may
  // reveal bad behavior, but "we did not see it" in a truncated sample is not proof.
  const organicReady = input.evidence.recentTrades.complete
    && walletAgeReliable
    && finite(wash.walletSharePct)
    && finite(bundles.currentSupplyPct)
    && finite(latestFlow?.netFlowSol);
  const organic = organicReady
    ? clamp(100
      - (wash.walletSharePct as number) * 3
      - (bundles.currentSupplyPct as number) * 1.2
      - (finite(ages.freshLt1hSupplyPct) ? (ages.freshLt1hSupplyPct as number) * 0.6 : 0)
      + Math.max(-20, Math.min(20, (latestFlow!.netFlowSol as number) * 2)))
    : null;

  const walletHistoryCoverage = input.evidence.walletHistory.coveragePct ?? 0;
  const smartHistorySufficient = (smart.walletCount ?? 0) > 0 || walletHistoryCoverage >= 80;
  const smartScore = smartHistorySufficient && finite(smart.netInflowSol) && finite(smart.walletCount)
    ? clamp(50 + (smart.netInflowSol as number) * 5 + (smart.walletCount as number) * 3)
    : null;

  const washCoordinationComponent = finite(wash.walletSharePct)
    && (input.evidence.recentTrades.complete || (wash.walletSharePct as number) > 0)
      ? (wash.walletSharePct as number) * 1.5
      : null;
  const coordinationComponents = [
    finite(bundles.currentSupplyPct) ? (bundles.currentSupplyPct as number) * 1.5 : null,
    finite(coordinated.score) ? (coordinated.score as number) * 0.7 : null,
    washCoordinationComponent,
  ].filter((value): value is number => value != null);
  const coordinationRisk = coordinationComponents.length >= 2 ? clamp(sum(coordinationComponents)) : null;

  const holderConfidence = holderRankingExact ? 95 : Math.min(70, c.sampleCoveragePct);
  const ageConfidence = ages.supplyCoveragePct;
  return {
    distributionQuality: score(distributionBase, (holderConfidence * 0.7 + ageConfidence * 0.3), [
      `adjusted Top-10 ${pctText(top10ForScore)}`,
      `fresh <24h supply ${pctText(ages.freshLt24hSupplyPct)} (age coverage ${ages.supplyCoveragePct.toFixed(1)}%)`,
    ]),
    insiderRisk: score(
      (insiders.candidateCount ?? 0) > 0 ? insiderRisk : insiders.coveragePct >= 80 ? 0 : null,
      insiders.coveragePct,
      [
      `${insiders.candidateCount ?? "unknown"} candidates`,
      `${pctText(insiders.candidateSupplyPct)} candidate supply`,
      `evidence coverage ${insiders.coveragePct.toFixed(1)}%`,
      ],
    ),
    creatorRisk: score(creatorRisk, creator.address ? Math.min(90, 30 + creatorComponents.filter((component) => finite(component.value)).length * 20) : 0, creator.address ? [
      `creator supply ${pctText(creator.currentSupplyPct)}`,
      `creator net cash ${finite(creator.netCashFlowSol) ? `${creator.netCashFlowSol.toFixed(2)} SOL` : "unknown"}`,
    ] : ["creator unavailable"]),
    liquidityQuality: score(liqScore, exit.liquidityUsd == null ? 0 : 70, [exit.liquidityUsd == null ? "liquidity unavailable" : `$${Math.round(exit.liquidityUsd).toLocaleString("en-US")} liquidity`]),
    exitLiquidity: score(exitScore, exit.available ? 90 : 0, [exit.available && exit10k != null ? `$10k estimated price impact ${exit10k.toFixed(1)}%` : exit.note]),
    organicDemand: score(organic, organic == null ? 0 : 70, [
      `wash ${pctText(wash.walletSharePct)} wallets`,
      `high-confidence coordinated supply ${pctText(bundles.currentSupplyPct)}`,
      `15m net flow ${finite(latestFlow?.netFlowSol) ? `${latestFlow!.netFlowSol!.toFixed(2)} SOL` : "unknown"}`,
    ]),
    smartMoneyActivity: score(smartScore, smartScore == null ? 0 : Math.min(90, walletHistoryCoverage), [
      `${smart.walletCount ?? "unknown"} historical-profitable wallets`,
      `net inflow ${finite(smart.netInflowSol) ? `${smart.netInflowSol.toFixed(2)} SOL` : "unknown"}`,
    ]),
    coordinationRisk: score(coordinationRisk, coordinationRisk == null ? 0 : 75, [
      `high-confidence coordinated supply ${pctText(bundles.currentSupplyPct)}`,
      `coordinated sell ${finite(coordinated.score) ? `${coordinated.score.toFixed(0)}/100` : "unknown"}`,
      `wash ${pctText(wash.walletSharePct)}`,
    ]),
  };
}

function evidenceCompleteness(evidence: ChainEvidenceCoverage): number {
  const statuses = Object.values(evidence);
  const scores = statuses.map((status) => {
    if (!status.available) return 0;
    if (status.complete) return 1;
    if (finite(status.coveragePct)) return clamp(status.coveragePct as number) / 100;
    return 0.5;
  });
  return (sum(scores) / scores.length) * 100;
}

export function analyzeChainQuality(input: ChainQualityInput): ChainQualityAnalytics {
  // Enforce a single as-of boundary for the entire V3/V3.3 base layer. A replay
  // caller may provide a superset of transactions; finite future rows must not leak
  // into bundles, wash, creator, flow, PnL, or transaction-quality evidence. Rows
  // with unknown timestamps are kept for timestamp-independent diagnostics only.
  const asOfSec = input.nowMs / 1000;
  const asOfFundingEdges = input.fundingEdges.filter(
    (edge) => !finite(edge.blockTime) || edge.blockTime! <= asOfSec + 1,
  );
  const allowedFundingPairs = new Set(asOfFundingEdges.map((edge) => `${edge.source}|${edge.target}`));
  const knownFundingPairs = new Set(input.fundingEdges.map((edge) => `${edge.source}|${edge.target}`));
  const asOfFundingGroups = input.fundingGroups
    .map((group) => ({
      ...group,
      wallets: group.wallets.filter((wallet) => {
        const pair = `${group.funder}|${wallet}`;
        // Preserve legacy/group-only evidence when there is no timestamped edge to
        // adjudicate it. If an edge exists, only an as-of edge may support membership.
        return !knownFundingPairs.has(pair) || allowedFundingPairs.has(pair);
      }),
    }))
    .filter((group) => group.wallets.length >= 2);
  input = {
    ...input,
    trades: input.trades.filter((trade) => !finite(trade.timestamp) || trade.timestamp <= asOfSec + 1),
    fundingEdges: asOfFundingEdges,
    fundingGroups: asOfFundingGroups,
  };
  const excluded = new Set([
    input.creator,
    input.pump?.bondingCurve ?? null,
    input.pump?.associatedBondingCurve ?? null,
    input.pump?.pumpSwapPool ?? null,
    input.market?.pairAddress ?? null,
  ].filter((value): value is string => Boolean(value)));
  const concentrationResult = concentration(input, excluded);
  const ages = walletAgeAnalytics(input);
  const first = firstBlocks(input);
  const snipers = sniperAnalytics(input);
  const bundles = bundleAnalytics(input);
  const funding = fundingAnalytics(input);
  const insiders = insiderAnalytics(input, snipers, funding, ages);
  const wash = washAnalytics(input);
  const smart = smartMoney(input);
  const flows = flowWindows(input);
  // Same-slot timing alone is not enough to call sells coordinated. Restrict the
  // global coordination metric to wallets connected by verified funding edges
  // or high-confidence coordinated-buy evidence; otherwise synchronous market activity can look
  // malicious on busy launches.
  const sellRelationGroups = [
    ...funding.groups.map((group) => new Set(group.wallets)),
    ...bundles.groups.filter((group) => group.classification === "verified_bundle" || group.classification === "high_confidence_coordination").map((group) => new Set(group.wallets)),
  ];
  const coordinated = sellCoordination(input, sellRelationGroups);
  const creator = creatorAnalytics(input);
  const exit = exitLiquidity(input);
  const tx = transactionQuality(input);
  const cross = crossToken(input);
  const holders = holderQuality(input);
  const walletProfiles = walletBehaviorProfiles(input, snipers, bundles, funding);
  const trends = trendWindows(input, {
    top10Pct: concentrationResult.top10Pct,
    adjustedTop10Pct: concentrationResult.adjustedTop10Pct,
    fresh24SupplyPct: ages.freshLt24hSupplyPct,
    insiderSupplyPct: insiders.candidateSupplyPct,
    bundleSupplyPct: bundles.currentSupplyPct,
    washWalletPct: wash.walletSharePct,
    smartInflowSol: smart.netInflowSol,
    liquidityUsd: exit.liquidityUsd,
  });
  const anomalyRows = anomalies(concentrationResult, ages, snipers, bundles, funding, insiders, wash, coordinated);
  return {
    concentration: concentrationResult,
    walletAge: ages,
    firstBlocks: first,
    snipers,
    bundles,
    funding,
    insiders,
    wash,
    smartMoney: smart,
    flows,
    coordinatedSelling: coordinated,
    creator,
    exitLiquidity: exit,
    bondingCurve: input.pump,
    migration: migrationAnalytics(input),
    transactions: tx,
    crossToken: cross,
    holderQuality: holders,
    walletProfiles,
    trends,
    anomalies: anomalyRows,
    dimensions: dimensions(input, concentrationResult, ages, insiders, creator, exit, wash, smart, bundles, coordinated, flows),
    evidence: input.evidence,
    evidenceCompletenessPct: evidenceCompleteness(input.evidence),
  };
}


// ─────────────────────────────────────────────────────────────
// Blockchain Analytics V3.4 integration
// ─────────────────────────────────────────────────────────────

export type ChainQualityAnalyticsWithWash = ChainQualityAnalytics & {
  wash: ChainQualityAnalytics["wash"] & { wallets?: string[] | null };
};

export interface ChainQualityAnalyticsV2 {
  walletPerformance: WalletPerformance[];
  concentrationDynamics: ConcentrationDynamics;
  orderFlow: OrderFlowImbalance;
  bundleAnalyticsV2: BundleAnalyticsV2;
  fundingTree: FundingTree;
  washTradingV2: WashTradingV2;
  lifecycle: LifecycleResult;
  contradictions: Contradiction[];
  compositeScores: CompositeScores;
  confidence: ScoreConfidence;
}

export type ChainQualityInputV2 = ChainQualityInput & {
  v1Result: ChainQualityAnalyticsWithWash;
  /** Optional full holder snapshots. V3.3 usually persists only aggregate top-10 history. */
  holdersSeries?: HolderSnapshot[];
  /** Optional holder-count series from chain-full for lifecycle growth. */
  holderCountSeries?: Array<{ ts: number; holders: number }>;
  /** Optional external narrative signal. Null by default; market flow is not narrative evidence. */
  narrativeSignal01?: number | null;
};

function creatorSellEvidence(input: ChainQualityInput): { soldPct: number | null; complete: boolean } {
  if (!input.creator) return { soldPct: null, complete: false };
  const complete = input.evidence.recentTrades.complete;
  if (!complete) return { soldPct: null, complete: false };
  const nowSec = input.nowMs / 1000;
  const rows = input.trades.filter((trade) =>
    trade.trader === input.creator && finite(trade.timestamp) && trade.timestamp <= nowSec + 1
  );
  const sells = rows.filter((trade) => trade.type === "sell" && Number.isFinite(trade.amountTokens) && trade.amountTokens > 0);
  if (sells.length === 0) return { soldPct: 0, complete: true };
  // We can prove that the creator sold, but not what percentage of creator allocation
  // was sold from trade history alone because minted/transferred inventory is not a buy.
  return { soldPct: null, complete: true };
}

/**
 * V3.4 enrichment over the already-computed V3.3 result.
 * Pure CPU: no HTTP, RPC or SQLite work is performed here.
 */
export function analyzeChainQualityV2(input: ChainQualityInputV2): ChainQualityAnalyticsV2 {
  const nowSec = input.nowMs / 1000;
  const asOfTrades = input.trades.filter((trade) => finite(trade.timestamp) && trade.timestamp <= nowSec + 1);

  // Fix #6: one index pass, no O(holders × trades) filtering.
  const tradesByHolder = new Map<string, RawTrade[]>();
  for (const trade of asOfTrades) {
    const rows = tradesByHolder.get(trade.trader) ?? [];
    rows.push(trade);
    tradesByHolder.set(trade.trader, rows);
  }

  const topHolders = [...input.holders].sort((a, b) => b.pct - a.pct).slice(0, 20);
  const walletPerformance = topHolders.map((holder) => computeWalletPerformance(
    holder.address,
    input.walletTokenHistory[holder.address] ?? [],
    tradesByHolder.get(holder.address) ?? [],
  ));

  const historicalSnapshots: HolderSnapshot[] = [
    ...(input.holdersSeries ?? []),
    ...input.history.map((row) => ({ timestamp: row.observedAt, top10Pct: row.top10Pct })),
  ];
  const concentrationDynamics = computeConcentrationDynamics(input.holders, historicalSnapshots, input.nowMs, "percent100");

  const recentCoverageSec = input.evidence.recentTrades.recentCoverageSec;
  const orderFlow = computeOrderFlow(asOfTrades, nowSec, recentCoverageSec, input.evidence.recentTrades.complete);

  const bundleGroups: BundleGroupInput[] = input.v1Result.bundles.groups
    .filter((group) => finite(group.startTs) && group.startTs <= nowSec + 1)
    .map((group) => ({
      bundleId: group.bundleId,
      wallets: group.wallets,
      startTs: group.startTs,
      quoteMint: group.quoteMint,
      currentSupplyPct: group.currentSupplyPct,
      classification: group.classification,
      atomicBundleVerified: group.atomicBundleVerified,
    }));
  const creatorFundedWallets = new Set(input.v1Result.funding.creatorFunderOverlapWallets);
  const bundleAnalyticsV2 = computeBundleAnalyticsV2(
    bundleGroups,
    asOfTrades,
    input.v1Result.bundles.currentSupplyPct,
    creatorFundedWallets,
    input.v1Result.bundles.available,
  );

  const asOfFundingEdges = input.fundingEdges.filter((edge) =>
    !finite(edge.blockTime) || edge.blockTime! <= nowSec + 1
  );
  const fundingTree = computeFundingTree(
    asOfFundingEdges,
    input.evidence.funding.available,
    input.evidence.funding.complete,
  );

  const suspiciousWallets = new Set(input.v1Result.wash.wallets ?? []);
  const observedWallets = new Set(
    asOfTrades.filter((trade) => trade.type === "buy" || trade.type === "sell").map((trade) => trade.trader).filter(Boolean),
  );
  const washTradingV2 = computeWashTradingV2(
    asOfTrades,
    suspiciousWallets,
    observedWallets.size,
    input.evidence.recentTrades.available,
    recentCoverageSec,
    nowSec,
  );

  const holderGrowth1h = computeHolderGrowth1hFromSeries(input.holderCountSeries ?? [], input.nowMs);
  const uniqueBuyersZ = computeUniqueBuyersZ(asOfTrades, nowSec, recentCoverageSec);
  const volumeGrowth1h = computeVolumeGrowth1h(asOfTrades, nowSec, recentCoverageSec);
  const currentSlot = asOfTrades.map((trade) => trade.slot)
    .filter((slot): slot is number => typeof slot === "number" && Number.isFinite(slot))
    .sort((a, b) => b - a)[0] ?? null;
  const launchSlot = input.evidence.launchHistory.launchSlot;
  const ageSlots = currentSlot != null && launchSlot != null && currentSlot >= launchSlot ? currentSlot - launchSlot : null;

  const lifecycle = detectLifecycleStage({
    ageSlots,
    uniqueBuyersZ,
    holderGrowth1h,
    ofi15m: orderFlow.ofi15m.value,
    concentrationVelocity1h: concentrationDynamics.velocity1h,
    bundlePnlPct: bundleAnalyticsV2.bundlePnlPct,
    liquidityUsd: input.market?.liquidityUsd ?? null,
    volumeGrowth1h,
  });

  const priceChangePct15m = priceChangePctWindow(asOfTrades, nowSec, 900);
  const creatorSell = creatorSellEvidence(input);
  const contradictions = detectContradictions({
    holderGrowth1h,
    uniqueBuyersZ,
    volumeGrowth1h,
    priceChangePct15m,
    bundlePnlPct: bundleAnalyticsV2.bundlePnlPct,
    bundleExitRatio: bundleAnalyticsV2.exitRatio,
    creatorFundedWallets: input.evidence.funding.available ? creatorFundedWallets.size : null,
    creatorSoldPct: creatorSell.soldPct,
    creatorSellCoverageComplete: creatorSell.complete,
    concentrationVelocity1h: concentrationDynamics.velocity1h,
    whaleNetFlow1h: orderFlow.whaleNetFlow1h,
    retailNetFlow1h: orderFlow.retailNetFlow1h,
    ofi15m: orderFlow.ofi15m.value,
  });

  const compositeScores = computeCompositeScores({
    walletPerformances: walletPerformance,
    bundleAnalytics: bundleAnalyticsV2,
    fundingTree,
    washTrading: washTradingV2,
    concentration: concentrationDynamics,
    orderFlow,
    holderGrowth1h,
    uniqueBuyersZ,
    narrativeSignal01: input.narrativeSignal01 ?? null,
    bundleEvidenceComplete: input.evidence.recentTrades.complete,
    washEvidenceComplete: input.evidence.recentTrades.complete,
    tradeCount: asOfTrades.length,
    holderCount: input.holders.length,
  });

  const confidence = computeScoreConfidence({
    tradeCount: input.trades.length,
    holderCount: input.holders.length,
    requiredFieldsPresent: [
      input.evidence.holders.available,
      input.evidence.recentTrades.available,
      input.evidence.walletHistory.available,
      input.evidence.funding.available,
      input.evidence.market.available,
    ].filter(Boolean).length,
    requiredFieldsTotal: 5,
    signalScores01: [
      orderFlow.ofi15m.value == null ? null : (orderFlow.ofi15m.value + 1) / 2,
      concentrationDynamics.velocity1h == null ? null : Math.max(0, Math.min(1, 0.5 - concentrationDynamics.velocity1h * 10)),
      washTradingV2.walletSharePct == null ? null : Math.max(0, Math.min(1, 1 - washTradingV2.walletSharePct / 25)),
    ],
  });

  return {
    walletPerformance,
    concentrationDynamics,
    orderFlow,
    bundleAnalyticsV2,
    fundingTree,
    washTradingV2,
    lifecycle,
    contradictions,
    compositeScores,
    confidence,
  };
}


// ─────────────────────────────────────────────────────────────
// Blockchain Analytics V3.5 temporal replay integration
// ─────────────────────────────────────────────────────────────

export type ChainQualityAnalyticsV3 = ChainTemporalAnalytics;

export type ChainQualityInputV3 = ChainQualityInputV2 & {
  v2Result: ChainQualityAnalyticsV2;
  /** Persisted V3.5 temporal anchors. Unknown/invalid rows should be filtered by the provider. */
  temporalHistory?: TemporalSignalSnapshot[];
  /** Cross-run exact-membership cluster history from local persistence. */
  walletClusterHistory?: PersistedClusterHistory[];
  /**
   * True only when upstream proves full inventory provenance (trades + token transfers).
   * Exhausting mint-address trade pagination alone is not sufficient for authoritative PnL.
   */
  tradeLedgerProvenanceComplete?: boolean;
};

/**
 * V3.5 temporal/on-chain replay over V3.4 evidence. Pure CPU: no HTTP/RPC/SQLite.
 * The returned snapshot is persisted by the provider only after analysis completes.
 */
export function analyzeChainQualityV3(input: ChainQualityInputV3): ChainQualityAnalyticsV3 {
  const nowSec = input.nowMs / 1000;
  const coverageSec = input.evidence.recentTrades.recentCoverageSec;
  const historyComplete = input.evidence.recentTrades.complete;
  const temporalHistory = (input.temporalHistory ?? []).filter(
    (row) => row.schemaVersion === 1 && Number.isFinite(row.observedAt) && row.observedAt <= input.nowMs,
  );

  const walletBehavior = computeWalletTemporalBehavior(input.trades, nowSec, coverageSec, historyComplete, 30);
  // Exhaustive mint-address pagination still does not prove inventory provenance:
  // airdrops/transfers/custody moves can change token inventory without a buy/sell.
  // Keep authoritative PnL null until an upstream transfer/balance-delta reconciler
  // explicitly proves launch-to-now inventory provenance.
  const ledgerHistoryComplete = input.evidence.recentTrades.complete && input.tradeLedgerProvenanceComplete === true;
  const costBasisLedgers = computeCostBasisLedgers(
    input.trades, 30, ledgerHistoryComplete, nowSec, 900,
  );
  const bundleGroups: TemporalBundleGroup[] = input.v1Result.bundles.groups.map((group) => ({
    wallets: group.wallets,
    classification: group.classification,
    startTs: group.startTs,
  }));
  const walletClusters = computeWalletClusterPersistence(
    input.trades, input.fundingEdges, bundleGroups, nowSec, coverageSec, input.walletClusterHistory ?? [],
  );
  const liquidityAdjustedFlow = computeLiquidityAdjustedFlow(
    input.trades,
    nowSec,
    coverageSec,
    historyComplete,
    {
      liquidityUsd: input.market?.liquidityUsd ?? null,
      quotePriceUsd: input.market?.quotePriceUsd ?? null,
      quoteTokenAddress: input.market?.quoteTokenAddress ?? null,
    },
  );
  const holderCohortMigration = computeHolderCohortMigration(
    input.holders,
    input.walletStats.map((row) => ({ address: row.address, firstSeen: row.firstSeen })),
    input.nowMs,
    temporalHistory,
  );

  const holderGrowth1h = computeHolderGrowth1hFromSeries(input.holderCountSeries ?? [], input.nowMs);
  const normalizeMigrationMs = (value: number | null | undefined): number | null => {
    if (!finite(value) || value <= 0) return null;
    const ms = value > 10_000_000_000 ? value : value * 1000;
    return ms <= input.nowMs + 60_000 ? ms : null;
  };
  const currentMigrationAt = input.market?.isCanonicalMigrationPool
    ? normalizeMigrationMs(input.market.pairCreatedAt)
    : null;
  const rememberedMigrationAt = temporalHistory
    .map((row) => normalizeMigrationMs(row.migrationAt))
    .filter((value): value is number => value != null)
    .reduce<number | null>((earliest, value) => earliest == null ? value : Math.min(earliest, value), null);

  const snapshot = buildTemporalSignalSnapshot({
    observedAt: input.nowMs,
    priceUsd: input.market?.priceUsd ?? null,
    liquidityUsd: input.market?.liquidityUsd ?? null,
    marketCapUsd: finite(input.market?.priceUsd) && input.market!.priceUsd! > 0 && finite(input.supply) && input.supply! > 0
      ? input.market!.priceUsd! * input.supply!
      : null,
    // Migration is historical-positive evidence. Once a canonical migration timestamp has
    // been observed, a later secondary-market selection must not erase it.
    migrationAt: currentMigrationAt ?? rememberedMigrationAt,
    lifecycleStage: input.v2Result.lifecycle.stage,
    compositeScores: input.v2Result.compositeScores,
    orderFlow: input.v2Result.orderFlow,
    holderGrowth1h,
    concentrationVelocity1h: input.v2Result.concentrationDynamics.velocity1h,
    liquidityAdjustedFlow,
    holderCohorts: holderCohortMigration.current,
  });

  // Replace an exact-timestamp duplicate so repeated analysis calls do not double-weight backtests.
  const replayMap = new Map<number, TemporalSignalSnapshot>();
  for (const row of temporalHistory) replayMap.set(row.observedAt, row);
  replayMap.set(snapshot.observedAt, snapshot);
  const outcomeReplay = computeOutcomeReplay([...replayMap.values()]);

  return {
    walletBehavior,
    costBasisLedgers,
    walletClusters,
    liquidityAdjustedFlow,
    holderCohortMigration,
    outcomeReplay,
    snapshot,
  };
}
