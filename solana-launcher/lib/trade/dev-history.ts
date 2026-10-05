// data-tag: lib.trade.dev_history_v2
// Pure historical creator-performance analytics. No network or DB I/O.

export interface DevHistoryTokenInput {
  mint: string;
  symbol?: string | null;
  name?: string | null;
  createdAt: number | null;
  marketCapUsd?: number | null;
  athUsd?: number | null;
  isMigrated: boolean;
  reached300k: boolean;
  /** Indexed UI token supply when known; used only to translate temporal price to market cap. */
  totalSupply?: number | null;
}

export interface RecurringDevWalletInput {
  wallet: string;
  tokenCount: number;
  tradeCount: number;
  volumeSol: number | null;
  firstSeen: number | null;
  lastSeen: number | null;
}

export interface DevThresholdStat {
  thresholdUsd: number;
  successCount: number;
  observedCount: number;
  rate: number | null;
  coverage: number;
}

export interface DevRollingStat {
  window: number | "lifetime";
  launches: number;
  observedCount: number;
  successCount: number;
  successRate: number | null;
  coverage: number;
}

export type DevPerformanceTrend = "improving" | "stable" | "declining" | "unknown";

export interface DevHistoryAnalytics {
  schemaVersion: 2;
  previousLaunches: number;
  migrationCount: number;
  migrationRate: number | null;
  ath: {
    observedCount: number;
    coverage: number;
    medianUsd: number | null;
    averageUsd: number | null;
    p25Usd: number | null;
    p75Usd: number | null;
    maxUsd: number | null;
  };
  thresholds: {
    reached100k: DevThresholdStat;
    reached300k: DevThresholdStat;
    reached1m: DevThresholdStat;
  };
  distribution: Array<{
    key: "under25k" | "25k_100k" | "100k_300k" | "300k_1m" | "over1m";
    label: string;
    minUsd: number;
    maxUsd: number | null;
    count: number;
    shareOfObserved: number | null;
  }>;
  rolling100k: {
    lifetime: DevRollingStat;
    last20: DevRollingStat;
    last5: DevRollingStat;
  };
  trend: {
    state: DevPerformanceTrend;
    recentWindow: number;
    previousWindow: number;
    recentMedianAthUsd: number | null;
    previousMedianAthUsd: number | null;
    recent100kRate: number | null;
    previous100kRate: number | null;
  };
  cadence: {
    observedLaunches: number;
    coverage: number;
    medianIntervalSec: number | null;
    averageIntervalSec: number | null;
    minIntervalSec: number | null;
    launches30d: number | null;
    maxLaunchesPerDay: number | null;
    lastLaunchAt: number | null;
  };
  recentLaunches: Array<{
    mint: string;
    symbol: string | null;
    name: string | null;
    createdAt: number | null;
    athUsd: number | null;
    currentMarketCapUsd: number | null;
    isMigrated: boolean;
    reached300k: boolean;
  }>;
  recurringNetwork: {
    wallets: RecurringDevWalletInput[];
    coveredTokens: number;
    totalTokens: number;
    coverage: number;
  };
  evidence: {
    athObserved: number;
    launchTimeObserved: number;
    recurringNetworkCoveredTokens: number;
    notes: string[];
  };
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

function timestampSec(value: number | null | undefined): number | null {
  if (!finite(value) || value <= 0) return null;
  return value > 10_000_000_000 ? value / 1000 : value;
}

function percentile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number | null {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  return percentile(sorted, 0.5);
}

function exactAth(token: DevHistoryTokenInput): number | null {
  if (!finite(token.athUsd) || token.athUsd <= 0) return null;
  // A persisted reached300k=true is affirmative historical evidence. If a later source
  // reports a lower "ATH", that value is stale/incomplete and must not be treated as exact.
  if (token.reached300k && token.athUsd < 300_000) return null;
  return token.athUsd;
}

function thresholdOutcome(token: DevHistoryTokenInput, thresholdUsd: number): boolean | null {
  // Positive historical evidence wins over a stale/incomplete numeric ATH.
  if (thresholdUsd <= 300_000 && token.reached300k) return true;
  const ath = exactAth(token);
  if (ath != null) return ath >= thresholdUsd;
  // A false reached300k value is not promoted to failure because legacy rows cannot
  // distinguish "checked false" from "not historically observed".
  return null;
}

function thresholdStat(tokens: DevHistoryTokenInput[], thresholdUsd: number): DevThresholdStat {
  let successCount = 0;
  let observedCount = 0;
  for (const token of tokens) {
    const outcome = thresholdOutcome(token, thresholdUsd);
    if (outcome == null) continue;
    observedCount += 1;
    if (outcome) successCount += 1;
  }
  return {
    thresholdUsd,
    successCount,
    observedCount,
    rate: observedCount > 0 ? successCount / observedCount : null,
    coverage: tokens.length > 0 ? observedCount / tokens.length : 0,
  };
}

function rollingStat(tokens: DevHistoryTokenInput[], window: number | "lifetime", thresholdUsd = 100_000): DevRollingStat {
  const slice = window === "lifetime" ? tokens : tokens.slice(0, window);
  const stat = thresholdStat(slice, thresholdUsd);
  return {
    window,
    launches: slice.length,
    observedCount: stat.observedCount,
    successCount: stat.successCount,
    successRate: stat.rate,
    coverage: stat.coverage,
  };
}

function trendState(args: {
  recentMedian: number | null;
  previousMedian: number | null;
  recentRate: number | null;
  previousRate: number | null;
}): DevPerformanceTrend {
  const { recentMedian, previousMedian, recentRate, previousRate } = args;
  const medianRatio = recentMedian != null && previousMedian != null && previousMedian > 0
    ? recentMedian / previousMedian
    : null;
  const rateDelta = recentRate != null && previousRate != null ? recentRate - previousRate : null;

  const improving = (medianRatio != null && medianRatio >= 1.5) || (rateDelta != null && rateDelta >= 0.2);
  const declining = (medianRatio != null && medianRatio <= 2 / 3) || (rateDelta != null && rateDelta <= -0.2);
  if (improving && declining) return "unknown";
  if (improving) return "improving";
  if (declining) return "declining";
  if (medianRatio != null || rateDelta != null) return "stable";
  return "unknown";
}

function dayKey(timestampSec: number): string {
  return new Date(timestampSec * 1000).toISOString().slice(0, 10);
}

export function computeDevHistoryAnalytics(args: {
  tokens: DevHistoryTokenInput[];
  currentMint?: string | null;
  recurringWallets?: RecurringDevWalletInput[];
  recurringCoveredTokens?: number;
  nowSec?: number;
}): DevHistoryAnalytics {
  const nowSec = finite(args.nowSec) ? args.nowSec : Math.floor(Date.now() / 1000);
  const currentMint = args.currentMint || null;
  const byMint = new Map<string, DevHistoryTokenInput>();
  for (const raw of args.tokens) {
    if (!raw.mint || raw.mint === currentMint) continue;
    const createdAt = timestampSec(raw.createdAt);
    // Future-dated rows are malformed/as-of-ineligible evidence and must never affect
    // historical creator performance. Unknown launch time is still allowed for ATH stats.
    if (createdAt != null && createdAt > nowSec + 60) continue;
    const normalized = { ...raw, createdAt };
    const existing = byMint.get(raw.mint);
    if (!existing) {
      byMint.set(raw.mint, normalized);
      continue;
    }
    // Defensive dedupe: positive historical flags and the highest exact ATH are monotonic.
    const a = exactAth(existing);
    const b = exactAth(normalized);
    const createdCandidates = [timestampSec(existing.createdAt), timestampSec(normalized.createdAt)]
      .filter((value): value is number => value != null);
    byMint.set(raw.mint, {
      ...existing,
      symbol: existing.symbol || normalized.symbol || null,
      name: existing.name || normalized.name || null,
      createdAt: createdCandidates.length ? Math.min(...createdCandidates) : null,
      athUsd: a == null ? normalized.athUsd ?? existing.athUsd ?? null : b == null ? existing.athUsd ?? null : Math.max(a, b),
      isMigrated: existing.isMigrated || normalized.isMigrated,
      reached300k: existing.reached300k || normalized.reached300k,
      totalSupply: existing.totalSupply ?? normalized.totalSupply ?? null,
    });
  }
  const previous = [...byMint.values()].sort((a, b) => {
      const at = timestampSec(a.createdAt) ?? -Infinity;
      const bt = timestampSec(b.createdAt) ?? -Infinity;
      if (at !== bt) return bt - at;
      return a.mint.localeCompare(b.mint);
    });

  const exactAths = previous.map(exactAth).filter((value): value is number => value != null).sort((a, b) => a - b);
  const athCoverage = previous.length > 0 ? exactAths.length / previous.length : 0;
  const migrationCount = previous.filter((token) => token.isMigrated).length;

  const distributionDefs = [
    { key: "under25k" as const, label: "< $25k", minUsd: 0, maxUsd: 25_000 },
    { key: "25k_100k" as const, label: "$25k–100k", minUsd: 25_000, maxUsd: 100_000 },
    { key: "100k_300k" as const, label: "$100k–300k", minUsd: 100_000, maxUsd: 300_000 },
    { key: "300k_1m" as const, label: "$300k–1M", minUsd: 300_000, maxUsd: 1_000_000 },
    { key: "over1m" as const, label: "> $1M", minUsd: 1_000_000, maxUsd: null },
  ];
  const distribution = distributionDefs.map((bucket) => {
    const count = exactAths.filter((ath) => ath >= bucket.minUsd && (bucket.maxUsd == null || ath < bucket.maxUsd)).length;
    return {
      ...bucket,
      count,
      shareOfObserved: exactAths.length > 0 ? count / exactAths.length : null,
    };
  });

  const lifetime = rollingStat(previous, "lifetime");
  const last20 = rollingStat(previous, 20);
  const last5 = rollingStat(previous, 5);

  const recentWindow = previous.slice(0, 10);
  const previousWindow = previous.slice(10, 20);
  const recentMedian = median(recentWindow.map(exactAth).filter((value): value is number => value != null));
  const previousMedian = median(previousWindow.map(exactAth).filter((value): value is number => value != null));
  const recent100k = thresholdStat(recentWindow, 100_000);
  const previous100k = thresholdStat(previousWindow, 100_000);
  const recentRate = recent100k.observedCount >= 3 ? recent100k.rate : null;
  const previousRate = previous100k.observedCount >= 3 ? previous100k.rate : null;
  const recentMedianUsable = recentWindow.filter((token) => exactAth(token) != null).length >= 3 ? recentMedian : null;
  const previousMedianUsable = previousWindow.filter((token) => exactAth(token) != null).length >= 3 ? previousMedian : null;

  const launchTimes = previous
    .map((token) => timestampSec(token.createdAt))
    .filter((value): value is number => value != null && value <= nowSec)
    .sort((a, b) => a - b);
  const intervals: number[] = [];
  for (let i = 1; i < launchTimes.length; i++) intervals.push(launchTimes[i] - launchTimes[i - 1]);
  const byDay = new Map<string, number>();
  for (const timestamp of launchTimes) byDay.set(dayKey(timestamp), (byDay.get(dayKey(timestamp)) || 0) + 1);
  const cutoff30d = nowSec - 30 * 86_400;
  const launches30d = launchTimes.length > 0 ? launchTimes.filter((timestamp) => timestamp >= cutoff30d).length : null;

  const recurringCoveredTokens = Math.max(0, Math.min(previous.length, Math.trunc(args.recurringCoveredTokens || 0)));
  const recurringWallets = (args.recurringWallets || [])
    .filter((row) => row.wallet && row.tokenCount >= 2)
    .slice(0, 20);

  const notes: string[] = [];
  const staleAthConflicts = previous.filter((token) => token.reached300k && finite(token.athUsd) && token.athUsd > 0 && token.athUsd < 300_000).length;
  if (athCoverage < 1) notes.push(`ATH coverage ${(athCoverage * 100).toFixed(0)}%; unknown ATH rows are excluded from failure denominators.`);
  if (staleAthConflicts > 0) notes.push(`${staleAthConflicts} stale ATH value(s) conflicted with reached300k evidence and were excluded from exact ATH statistics.`);
  if (launchTimes.length < previous.length) notes.push("Launch cadence uses only tokens with a known, non-future createdAt timestamp.");
  if (previous.length > 0 && recurringCoveredTokens < previous.length) notes.push("Recurring-wallet network is based only on previous tokens with locally persisted trade history.");
  notes.push("Confirmed migration share is a lower bound: positive indexed migrations are trusted, while legacy false rows can include unverified/unknown status.");
  notes.push("The current mint is excluded from all historical creator-performance statistics.");

  return {
    schemaVersion: 2,
    previousLaunches: previous.length,
    migrationCount,
    migrationRate: previous.length > 0 ? migrationCount / previous.length : null,
    ath: {
      observedCount: exactAths.length,
      coverage: athCoverage,
      medianUsd: percentile(exactAths, 0.5),
      averageUsd: mean(exactAths),
      p25Usd: percentile(exactAths, 0.25),
      p75Usd: percentile(exactAths, 0.75),
      maxUsd: exactAths.length > 0 ? exactAths[exactAths.length - 1] : null,
    },
    thresholds: {
      reached100k: thresholdStat(previous, 100_000),
      reached300k: thresholdStat(previous, 300_000),
      reached1m: thresholdStat(previous, 1_000_000),
    },
    distribution,
    rolling100k: { lifetime, last20, last5 },
    trend: {
      state: trendState({ recentMedian: recentMedianUsable, previousMedian: previousMedianUsable, recentRate, previousRate }),
      recentWindow: recentWindow.length,
      previousWindow: previousWindow.length,
      recentMedianAthUsd: recentMedianUsable,
      previousMedianAthUsd: previousMedianUsable,
      recent100kRate: recentRate,
      previous100kRate: previousRate,
    },
    cadence: {
      observedLaunches: launchTimes.length,
      coverage: previous.length > 0 ? launchTimes.length / previous.length : 0,
      medianIntervalSec: median(intervals),
      averageIntervalSec: mean(intervals),
      minIntervalSec: intervals.length > 0 ? Math.min(...intervals) : null,
      launches30d,
      maxLaunchesPerDay: byDay.size > 0 ? Math.max(...byDay.values()) : null,
      lastLaunchAt: launchTimes.length > 0 ? launchTimes[launchTimes.length - 1] : null,
    },
    recentLaunches: previous.slice(0, 12).map((token) => ({
      mint: token.mint,
      symbol: token.symbol || null,
      name: token.name || null,
      createdAt: token.createdAt,
      athUsd: exactAth(token),
      currentMarketCapUsd: finite(token.marketCapUsd) && token.marketCapUsd > 0 ? token.marketCapUsd : null,
      isMigrated: token.isMigrated,
      reached300k: token.reached300k,
    })),
    recurringNetwork: {
      wallets: recurringWallets,
      coveredTokens: recurringCoveredTokens,
      totalTokens: previous.length,
      coverage: previous.length > 0 ? clamp01(recurringCoveredTokens / previous.length) : 0,
    },
    evidence: {
      athObserved: exactAths.length,
      launchTimeObserved: launchTimes.length,
      recurringNetworkCoveredTokens: recurringCoveredTokens,
      notes,
    },
  };
}


// ─────────────────────────────────────────────────────────────
// DEV History V3: launch outcome curves + ATH drawdown + post-migration replay
// Pure CPU. The route supplies only nearest persisted temporal observations.
// ─────────────────────────────────────────────────────────────

export type DevOutcomeHorizon = "5m" | "15m" | "1h" | "6h" | "24h";
export type DevPostMigrationHorizon = "1h" | "6h" | "24h";

export interface DevTemporalPointInput {
  observedAt: number;
  priceUsd: number | null;
  liquidityUsd: number | null;
  marketCapUsd?: number | null;
}

export interface DevOutcomeTokenInput {
  mint: string;
  symbol?: string | null;
  createdAt: number | null;
  athUsd?: number | null;
  totalSupply?: number | null;
  launchAnchor: DevTemporalPointInput | null;
  launchTargets: Partial<Record<DevOutcomeHorizon, DevTemporalPointInput | null>>;
  migrationAt?: number | null;
  migrationAnchor?: DevTemporalPointInput | null;
  migrationTargets?: Partial<Record<DevPostMigrationHorizon, DevTemporalPointInput | null>>;
}

export interface DevOutcomeHorizonStat {
  horizon: DevOutcomeHorizon;
  /** All matured launches in creator history, regardless of local temporal retention. */
  eligibleLaunches: number;
  /** Matured launches whose launch anchor still falls inside the configured retention window. */
  retentionEligibleLaunches: number;
  samples: number;
  retentionSamples: number;
  /** Lifetime evidence share; useful to expose how much of the creator history was locally observed. */
  coverage: number;
  /** Coverage of the period the local temporal store is actually expected to retain. */
  retentionCoverage: number;
  meanReturnPct: number | null;
  medianReturnPct: number | null;
  p25ReturnPct: number | null;
  p75ReturnPct: number | null;
  positiveReturnRate: number | null;
  recordedAthDrawdownSamples: number;
  medianRecordedAthDrawdownPct: number | null;
  staleAthConflictCount: number;
}

export interface DevPostMigrationStat {
  horizon: DevPostMigrationHorizon;
  eligibleMigrations: number;
  retentionEligibleMigrations: number;
  returnSamples: number;
  retentionReturnSamples: number;
  returnCoverage: number;
  retentionReturnCoverage: number;
  medianReturnPct: number | null;
  positiveReturnRate: number | null;
  survivalObserved: number;
  retentionSurvivalObserved: number;
  survivalCoverage: number;
  retentionSurvivalCoverage: number;
  aliveCount: number;
  explicitDeadCount: number;
  survivalConflictCount: number;
  survivalRate: number | null;
}

export interface DevOutcomeAnalytics {
  schemaVersion: 2;
  retentionDays: number;
  launchAnchorObserved: number;
  launchAnchorCoverage: number;
  retentionEligibleLaunchAnchors: number;
  retentionLaunchAnchorCoverage: number;
  horizons: Record<DevOutcomeHorizon, DevOutcomeHorizonStat>;
  postMigration: {
    migrationTimestampObserved: number;
    migrationAnchorObserved: number;
    horizons: Record<DevPostMigrationHorizon, DevPostMigrationStat>;
  };
  recent: Array<{
    mint: string;
    symbol: string | null;
    createdAt: number | null;
    returnsPct: Partial<Record<DevOutcomeHorizon, number | null>>;
    recordedAthDrawdownPct24h: number | null;
  }>;
  evidence: {
    temporalTokens: number;
    notes: string[];
  };
}

export const DEV_OUTCOME_CONFIG: Record<DevOutcomeHorizon, { offsetMs: number; toleranceMs: number }> = {
  "5m": { offsetMs: 5 * 60_000, toleranceMs: 2 * 60_000 },
  "15m": { offsetMs: 15 * 60_000, toleranceMs: 5 * 60_000 },
  "1h": { offsetMs: 60 * 60_000, toleranceMs: 15 * 60_000 },
  "6h": { offsetMs: 6 * 60 * 60_000, toleranceMs: 60 * 60_000 },
  "24h": { offsetMs: 24 * 60 * 60_000, toleranceMs: 3 * 60 * 60_000 },
};
const POST_MIGRATION_HORIZONS: DevPostMigrationHorizon[] = ["1h", "6h", "24h"];
const DEV_OUTCOME_HORIZONS: DevOutcomeHorizon[] = ["5m", "15m", "1h", "6h", "24h"];
const LAUNCH_ANCHOR_EARLY_MS = 30_000;
const LAUNCH_ANCHOR_LATE_MS = 90_000;
const MIGRATION_ANCHOR_LATE_MS = 5 * 60_000;

function devTimestampMs(value: number | null | undefined): number | null {
  if (!finite(value) || value! <= 0) return null;
  return value! > 10_000_000_000 ? value! : value! * 1000;
}

function pointObservedMs(point: DevTemporalPointInput | null | undefined): number | null {
  return point ? devTimestampMs(point.observedAt) : null;
}

function pointWithin(
  point: DevTemporalPointInput | null | undefined,
  targetAt: number,
  earlyMs: number,
  lateMs: number,
  nowMs: number,
): DevTemporalPointInput | null {
  const observedAt = pointObservedMs(point);
  if (observedAt == null || observedAt > nowMs + 1_000) return null;
  if (observedAt < targetAt - earlyMs || observedAt > targetAt + lateMs) return null;
  return point ?? null;
}

function usablePrice(point: DevTemporalPointInput | null | undefined): number | null {
  return point && finite(point.priceUsd) && point.priceUsd > 0 ? point.priceUsd : null;
}

function returnPct(anchor: DevTemporalPointInput | null | undefined, target: DevTemporalPointInput | null | undefined): number | null {
  const a = usablePrice(anchor);
  const b = usablePrice(target);
  if (a == null || b == null) return null;
  return ((b / a) - 1) * 100;
}

function recordedAthDrawdownPct(token: DevOutcomeTokenInput, target: DevTemporalPointInput | null | undefined): { value: number | null; staleConflict: boolean } {
  const price = usablePrice(target);
  const ath = finite(token.athUsd) && token.athUsd! > 0 ? token.athUsd! : null;
  const supply = finite(token.totalSupply) && token.totalSupply! > 0 ? token.totalSupply! : null;
  const directMarketCap = target && finite(target.marketCapUsd) && target.marketCapUsd! > 0 ? target.marketCapUsd! : null;
  const marketCap = directMarketCap ?? (price != null && supply != null ? price * supply : null);
  if (ath == null || marketCap == null) return { value: null, staleConflict: false };
  // A target MC above the persisted ATH means the ATH index is stale/incomplete. Exclude it
  // instead of emitting a negative drawdown or silently clamping contradictory evidence.
  if (marketCap > ath * 1.02) return { value: null, staleConflict: true };
  return { value: Math.max(0, (1 - marketCap / ath) * 100), staleConflict: false };
}

function pctStats(values: number[]): {
  mean: number | null;
  median: number | null;
  p25: number | null;
  p75: number | null;
  positiveRate: number | null;
} {
  const clean = values.filter(finite).sort((a, b) => a - b);
  return {
    mean: mean(clean),
    median: percentile(clean, 0.5),
    p25: percentile(clean, 0.25),
    p75: percentile(clean, 0.75),
    positiveRate: clean.length > 0 ? clean.filter((value) => value > 0).length / clean.length : null,
  };
}

/**
 * Aggregate historical launch outcomes from persisted temporal evidence.
 * Missing target observations never become zero returns or failed outcomes.
 */
export function computeDevOutcomeAnalytics(args: {
  tokens: DevOutcomeTokenInput[];
  nowMs?: number;
  retentionDays?: number;
}): DevOutcomeAnalytics {
  const nowMs = finite(args.nowMs) ? args.nowMs! : Date.now();
  const retentionDays = finite(args.retentionDays) && args.retentionDays! > 0 ? args.retentionDays! : 14;
  const retentionCutoffMs = nowMs - retentionDays * 86_400_000;

  const byMint = new Map<string, DevOutcomeTokenInput>();
  for (const token of args.tokens) {
    if (!token.mint || byMint.has(token.mint)) continue;
    const createdMs = devTimestampMs(token.createdAt);
    // Future launch rows are invalid in an as-of historical profile. Unknown createdAt can
    // still participate in post-migration evidence when a valid migration timestamp exists.
    if (createdMs != null && createdMs > nowMs + 60_000) continue;
    byMint.set(token.mint, token);
  }
  const tokens = [...byMint.values()];

  const validLaunchAnchor = (token: DevOutcomeTokenInput): DevTemporalPointInput | null => {
    const createdMs = devTimestampMs(token.createdAt);
    if (createdMs == null || createdMs > nowMs) return null;
    return pointWithin(token.launchAnchor, createdMs, LAUNCH_ANCHOR_EARLY_MS, LAUNCH_ANCHOR_LATE_MS, nowMs);
  };
  const validLaunchTarget = (token: DevOutcomeTokenInput, horizon: DevOutcomeHorizon): DevTemporalPointInput | null => {
    const createdMs = devTimestampMs(token.createdAt);
    if (createdMs == null) return null;
    const cfg = DEV_OUTCOME_CONFIG[horizon];
    const targetAt = createdMs + cfg.offsetMs;
    if (targetAt > nowMs) return null;
    return pointWithin(token.launchTargets[horizon], targetAt, 0, cfg.toleranceMs, nowMs);
  };
  const validMigrationAnchor = (token: DevOutcomeTokenInput): DevTemporalPointInput | null => {
    const migrationMs = devTimestampMs(token.migrationAt);
    if (migrationMs == null || migrationMs > nowMs) return null;
    return pointWithin(token.migrationAnchor, migrationMs, 0, MIGRATION_ANCHOR_LATE_MS, nowMs);
  };
  const validMigrationTarget = (token: DevOutcomeTokenInput, horizon: DevPostMigrationHorizon): DevTemporalPointInput | null => {
    const migrationMs = devTimestampMs(token.migrationAt);
    if (migrationMs == null) return null;
    const cfg = DEV_OUTCOME_CONFIG[horizon];
    const targetAt = migrationMs + cfg.offsetMs;
    if (targetAt > nowMs) return null;
    return pointWithin(token.migrationTargets?.[horizon] ?? null, targetAt, 0, cfg.toleranceMs, nowMs);
  };

  const launchKnown = tokens.filter((token) => {
    const createdMs = devTimestampMs(token.createdAt);
    return createdMs != null && createdMs <= nowMs;
  });
  const launchAnchorObserved = launchKnown.filter((token) => usablePrice(validLaunchAnchor(token)) != null).length;
  const retentionLaunchTokens = launchKnown.filter((token) => (devTimestampMs(token.createdAt) ?? -Infinity) >= retentionCutoffMs);
  const retentionLaunchAnchorObserved = retentionLaunchTokens.filter((token) => usablePrice(validLaunchAnchor(token)) != null).length;

  const horizonRows = {} as Record<DevOutcomeHorizon, DevOutcomeHorizonStat>;
  for (const horizon of DEV_OUTCOME_HORIZONS) {
    const horizonMs = DEV_OUTCOME_CONFIG[horizon].offsetMs;
    const eligible = launchKnown.filter((token) => {
      const createdMs = devTimestampMs(token.createdAt)!;
      return createdMs + horizonMs <= nowMs;
    });
    const retentionEligible = eligible.filter((token) => (devTimestampMs(token.createdAt) ?? -Infinity) >= retentionCutoffMs);
    const retentionEligibleMints = new Set(retentionEligible.map((token) => token.mint));
    const returns: number[] = [];
    let retentionSamples = 0;
    const drawdowns: number[] = [];
    let staleAthConflictCount = 0;
    for (const token of eligible) {
      const anchor = validLaunchAnchor(token);
      const target = validLaunchTarget(token, horizon);
      const value = returnPct(anchor, target);
      if (value != null) {
        returns.push(value);
        if (retentionEligibleMints.has(token.mint)) retentionSamples++;
      }
      const drawdown = recordedAthDrawdownPct(token, target);
      if (drawdown.value != null) drawdowns.push(drawdown.value);
      if (drawdown.staleConflict) staleAthConflictCount++;
    }
    const stats = pctStats(returns);
    horizonRows[horizon] = {
      horizon,
      eligibleLaunches: eligible.length,
      retentionEligibleLaunches: retentionEligible.length,
      samples: returns.length,
      retentionSamples,
      coverage: eligible.length > 0 ? returns.length / eligible.length : 0,
      retentionCoverage: retentionEligible.length > 0 ? retentionSamples / retentionEligible.length : 0,
      meanReturnPct: stats.mean,
      medianReturnPct: stats.median,
      p25ReturnPct: stats.p25,
      p75ReturnPct: stats.p75,
      positiveReturnRate: stats.positiveRate,
      recordedAthDrawdownSamples: drawdowns.length,
      medianRecordedAthDrawdownPct: median(drawdowns),
      staleAthConflictCount,
    };
  }

  const migrationTokens = tokens.filter((token) => {
    const migrationMs = devTimestampMs(token.migrationAt);
    return migrationMs != null && migrationMs <= nowMs;
  });
  const migrationAnchorObserved = migrationTokens.filter((token) => usablePrice(validMigrationAnchor(token)) != null).length;
  const migrationHorizonRows = {} as Record<DevPostMigrationHorizon, DevPostMigrationStat>;
  for (const horizon of POST_MIGRATION_HORIZONS) {
    const horizonMs = DEV_OUTCOME_CONFIG[horizon].offsetMs;
    const eligible = migrationTokens.filter((token) => {
      const migrationMs = devTimestampMs(token.migrationAt)!;
      return migrationMs + horizonMs <= nowMs;
    });
    const retentionEligible = eligible.filter((token) => (devTimestampMs(token.migrationAt) ?? -Infinity) >= retentionCutoffMs);
    const retentionEligibleMints = new Set(retentionEligible.map((token) => token.mint));
    const returns: number[] = [];
    let retentionReturnSamples = 0;
    let aliveCount = 0;
    let explicitDeadCount = 0;
    let survivalConflictCount = 0;
    let retentionSurvivalObserved = 0;
    for (const token of eligible) {
      const anchor = validMigrationAnchor(token);
      const target = validMigrationTarget(token, horizon);
      const value = returnPct(anchor, target);
      if (value != null) {
        returns.push(value);
        if (retentionEligibleMints.has(token.mint)) retentionReturnSamples++;
      }

      if (!target) continue;
      const price = usablePrice(target);
      const liquidity = finite(target.liquidityUsd) && target.liquidityUsd! >= 0 ? target.liquidityUsd! : null;
      let observedSurvival = false;
      if (liquidity != null && liquidity > 0) {
        // Positive observed liquidity is sufficient evidence that the observed market survived,
        // even if the price field is temporarily missing.
        aliveCount++;
        observedSurvival = true;
      } else if (liquidity === 0 && price == null) {
        explicitDeadCount++;
        observedSurvival = true;
      } else if (liquidity === 0 && price != null) {
        // Positive price plus exact zero liquidity is contradictory evidence, not a death label.
        survivalConflictCount++;
      }
      if (observedSurvival && retentionEligibleMints.has(token.mint)) retentionSurvivalObserved++;
    }
    const returnStats = pctStats(returns);
    const survivalObserved = aliveCount + explicitDeadCount;
    migrationHorizonRows[horizon] = {
      horizon,
      eligibleMigrations: eligible.length,
      retentionEligibleMigrations: retentionEligible.length,
      returnSamples: returns.length,
      retentionReturnSamples,
      returnCoverage: eligible.length > 0 ? returns.length / eligible.length : 0,
      retentionReturnCoverage: retentionEligible.length > 0 ? retentionReturnSamples / retentionEligible.length : 0,
      medianReturnPct: returnStats.median,
      positiveReturnRate: returnStats.positiveRate,
      survivalObserved,
      retentionSurvivalObserved,
      survivalCoverage: eligible.length > 0 ? survivalObserved / eligible.length : 0,
      retentionSurvivalCoverage: retentionEligible.length > 0 ? retentionSurvivalObserved / retentionEligible.length : 0,
      aliveCount,
      explicitDeadCount,
      survivalConflictCount,
      survivalRate: survivalObserved > 0 ? aliveCount / survivalObserved : null,
    };
  }

  const recent = tokens
    .filter((token) => {
      const createdMs = devTimestampMs(token.createdAt);
      return createdMs == null || createdMs <= nowMs;
    })
    .slice()
    .sort((a, b) => (devTimestampMs(b.createdAt) ?? -Infinity) - (devTimestampMs(a.createdAt) ?? -Infinity))
    .slice(0, 12)
    .map((token) => {
      const returnsPct: Partial<Record<DevOutcomeHorizon, number | null>> = {};
      for (const horizon of DEV_OUTCOME_HORIZONS) {
        returnsPct[horizon] = returnPct(validLaunchAnchor(token), validLaunchTarget(token, horizon));
      }
      return {
        mint: token.mint,
        symbol: token.symbol ?? null,
        createdAt: timestampSec(token.createdAt),
        returnsPct,
        recordedAthDrawdownPct24h: recordedAthDrawdownPct(token, validLaunchTarget(token, "24h")).value,
      };
    });

  const notes: string[] = [
    "Launch returns require a persisted price observation close to launch and a horizon-specific temporal target; missing or out-of-window observations are excluded, never treated as 0% returns.",
    `Local temporal persistence is expected to retain approximately ${retentionDays} days. Lifetime coverage and retention-window coverage are reported separately because the outcome sample is not a lifetime census.`,
    "Recorded-ATH drawdown prefers directly persisted market cap. Guessed/unverified token supply must not be used as market-cap evidence.",
    "Post-migration replay rejects pre-migration anchors. Positive liquidity proves observed market survival; zero-liquidity plus positive price is contradictory and remains unknown.",
  ];

  return {
    schemaVersion: 2,
    retentionDays,
    launchAnchorObserved,
    launchAnchorCoverage: launchKnown.length > 0 ? launchAnchorObserved / launchKnown.length : 0,
    retentionEligibleLaunchAnchors: retentionLaunchTokens.length,
    retentionLaunchAnchorCoverage: retentionLaunchTokens.length > 0 ? retentionLaunchAnchorObserved / retentionLaunchTokens.length : 0,
    horizons: horizonRows,
    postMigration: {
      migrationTimestampObserved: migrationTokens.length,
      migrationAnchorObserved,
      horizons: migrationHorizonRows,
    },
    recent,
    evidence: {
      temporalTokens: tokens.filter((token) => validLaunchAnchor(token) || DEV_OUTCOME_HORIZONS.some((horizon) => validLaunchTarget(token, horizon))).length,
      notes,
    },
  };
}
