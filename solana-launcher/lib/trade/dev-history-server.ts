import { analyzeDev, getCreatorForMint } from "./dev";
import {
  getDevRecurringWallets,
  getDevTokensByCreator,
  getDevWallet,
  getLatestDevTemporalSnapshots,
  getNearestChainTemporalSnapshots,
  getLatestDevForensicsAnalysis,
  getPersistedCreatorForMint,
} from "./db";
import {
  computeDevHistoryAnalytics,
  computeDevOutcomeAnalytics,
  DEV_OUTCOME_CONFIG,
  type DevHistoryAnalytics,
  type DevHistoryTokenInput,
  type DevOutcomeAnalytics,
  type DevOutcomeHorizon,
  type DevOutcomeTokenInput,
  type DevPostMigrationHorizon,
  type DevTemporalPointInput,
} from "./dev-history";

const POST_MIGRATION_HORIZONS: DevPostMigrationHorizon[] = ["1h", "6h", "24h"];
const TEMPORAL_RETENTION_DAYS = 14;

function normalizeTimestampMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value > 10_000_000_000 ? value : value * 1000;
}

function temporalPoint(snapshot: {
  observedAt: number;
  priceUsd: number | null;
  liquidityUsd: number | null;
  marketCapUsd?: number | null;
} | null | undefined): DevTemporalPointInput | null {
  if (!snapshot || !Number.isFinite(snapshot.observedAt)) return null;
  return {
    observedAt: snapshot.observedAt,
    priceUsd: typeof snapshot.priceUsd === "number" && Number.isFinite(snapshot.priceUsd) && snapshot.priceUsd > 0 ? snapshot.priceUsd : null,
    liquidityUsd: typeof snapshot.liquidityUsd === "number" && Number.isFinite(snapshot.liquidityUsd) && snapshot.liquidityUsd >= 0 ? snapshot.liquidityUsd : null,
    marketCapUsd: typeof snapshot.marketCapUsd === "number" && Number.isFinite(snapshot.marketCapUsd) && snapshot.marketCapUsd > 0 ? snapshot.marketCapUsd : null,
  };
}

function toHistoryToken(token: {
  mint: string;
  symbol?: string | null;
  name?: string | null;
  createdAt?: number | null;
  marketCapUsd?: number | null;
  athUsd?: number | null;
  isMigrated?: boolean;
  reached300k?: boolean;
  totalSupply?: number | null;
}): DevHistoryTokenInput {
  return {
    mint: token.mint,
    symbol: token.symbol ?? null,
    name: token.name ?? null,
    createdAt: token.createdAt ?? null,
    marketCapUsd: token.marketCapUsd ?? null,
    athUsd: token.athUsd ?? null,
    isMigrated: token.isMigrated === true,
    reached300k: token.reached300k === true,
    totalSupply: typeof token.totalSupply === "number" && Number.isFinite(token.totalSupply) && token.totalSupply > 0 ? token.totalSupply : null,
  };
}

export type DevHistoryForensicsSummary = {
  available: boolean;
  analyzedAt: number | null;
  medianLifespanHours: number | null;
  averageLifespanHours: number | null;
  over24hSurvivalRate: number | null;
  lifespanObserved: number;
  lifespanCoverage: number;
};

export type DevHistoryServerReport =
  | {
      available: false;
      creator: string | null;
      mint: string | null;
      reason: string;
      status: number;
    }
  | {
      available: true;
      creator: string;
      mint: string | null;
      fetchedAt: number;
      source: "live-or-cache" | "local-cache";
      warning: string | null;
      analytics: DevHistoryAnalytics;
      outcomes: DevOutcomeAnalytics;
      forensics: DevHistoryForensicsSummary;
    };

export async function buildDevHistoryReport(args: {
  mint?: string | null;
  creator?: string | null;
  refresh?: boolean;
  nowMs?: number;
}): Promise<DevHistoryServerReport> {
  const mint = args.mint?.trim() || null;
  let creator = args.creator?.trim() || null;
  const refresh = args.refresh === true;
  const nowMs = args.nowMs ?? Date.now();

  if (!creator && mint) creator = getPersistedCreatorForMint(mint) || await getCreatorForMint(mint);
  if (!creator) return { available: false, creator: null, mint, reason: "creator unavailable", status: 200 };

  let tokens: DevHistoryTokenInput[] = [];
  let fetchedAt = nowMs;
  let source: "live-or-cache" | "local-cache" = "live-or-cache";
  let warning: string | null = null;

  try {
    const dev = await analyzeDev(creator, { maxTokens: 5000, skipCache: refresh });
    tokens = dev.tokens.map(toHistoryToken);
    fetchedAt = dev.fetchedAt;
  } catch (error) {
    const cached = getDevTokensByCreator(creator, 5000);
    if (cached.length === 0) {
      const message = error instanceof Error ? error.message : "DEV history unavailable";
      return { available: false, creator, mint, reason: message, status: 502 };
    }
    tokens = cached.map(toHistoryToken);
    const walletRow = getDevWallet(creator);
    const tokenUpdatedAt = cached
      .map((row) => row.lastUpdatedAt)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0)
      .reduce<number | null>((oldest, value) => oldest == null ? value : Math.min(oldest, value), null);
    // A cache fallback must carry the timestamp of the persisted evidence, not the
    // current request time. Otherwise stale DEV history looks freshly observed.
    fetchedAt = walletRow?.lastUpdatedAt && Number.isFinite(walletRow.lastUpdatedAt)
      ? walletRow.lastUpdatedAt
      : tokenUpdatedAt ?? 0;
    source = "local-cache";
    warning = error instanceof Error
      ? `Live DEV history failed (${error.message}); using persisted creator history.`
      : "Live DEV history failed; using persisted creator history.";
  }

  const recurring = getDevRecurringWallets(creator, mint, 20);
  const latestForensics = getLatestDevForensicsAnalysis(creator);
  const forensicsPayload = latestForensics?.payload && typeof latestForensics.payload === "object"
    ? latestForensics.payload as Record<string, unknown>
    : null;
  const finiteNumber = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const forensicsTokens = Array.isArray(forensicsPayload?.tokens)
    ? (forensicsPayload!.tokens as Array<Record<string, unknown>>)
        .filter((token) => typeof token?.mint === "string" && token.mint !== mint)
    : [];
  const lifespanHours = forensicsTokens
    .map((token) => finiteNumber(token.lifespanHours))
    .filter((value): value is number => value != null && value >= 0)
    .sort((a, b) => a - b);
  const medianOf = (values: number[]): number | null => {
    if (values.length === 0) return null;
    const mid = Math.floor(values.length / 2);
    return values.length % 2 === 0 ? (values[mid - 1] + values[mid]) / 2 : values[mid];
  };
  const medianLifespanHours = medianOf(lifespanHours);
  const averageLifespanHours = lifespanHours.length > 0
    ? lifespanHours.reduce((sum, value) => sum + value, 0) / lifespanHours.length
    : null;
  const lifespanObserved = lifespanHours.length;
  const over24hCount = lifespanHours.filter((value) => value >= 24).length;

  const analytics = computeDevHistoryAnalytics({
    tokens,
    currentMint: mint,
    recurringWallets: recurring.recurringWallets,
    recurringCoveredTokens: recurring.coveredTokens,
    nowSec: Math.floor(nowMs / 1000),
  });

  const previousTokens = tokens.filter((token) => token.mint !== mint);
  const migrationByMint = new Map<string, number>();
  for (const token of forensicsTokens) {
    const tokenMint = typeof token.mint === "string" ? token.mint : null;
    const migrationAt = normalizeTimestampMs(token.migrationTimestamp);
    if (tokenMint && migrationAt != null && migrationAt <= nowMs) {
      const existing = migrationByMint.get(tokenMint);
      migrationByMint.set(tokenMint, existing == null ? migrationAt : Math.min(existing, migrationAt));
    }
  }

  const latestTemporal = getLatestDevTemporalSnapshots(
    creator,
    mint,
    nowMs - (TEMPORAL_RETENTION_DAYS + 1) * 86_400_000,
  );
  for (const row of latestTemporal) {
    const migrationAt = normalizeTimestampMs(row.snapshot.migrationAt);
    if (migrationAt != null && migrationAt <= nowMs) {
      const existing = migrationByMint.get(row.mint);
      migrationByMint.set(row.mint, existing == null ? migrationAt : Math.min(existing, migrationAt));
    }
  }

  const lookupTargets: Array<{
    key: string;
    mint: string;
    targetAt: number;
    toleranceMs: number;
    notBeforeTarget?: boolean;
  }> = [];
  for (const token of previousTokens) {
    const launchAt = normalizeTimestampMs(token.createdAt);
    if (launchAt == null || launchAt > nowMs) continue;
    if (launchAt >= nowMs - (TEMPORAL_RETENTION_DAYS * 86_400_000 + 24 * 60 * 60_000)) {
      lookupTargets.push({ key: `launch:${token.mint}:anchor`, mint: token.mint, targetAt: launchAt, toleranceMs: 90_000 });
      for (const [horizon, cfg] of Object.entries(DEV_OUTCOME_CONFIG) as Array<[DevOutcomeHorizon, { offsetMs: number; toleranceMs: number }]>) {
        const targetAt = launchAt + cfg.offsetMs;
        if (targetAt <= nowMs) lookupTargets.push({ key: `launch:${token.mint}:${horizon}`, mint: token.mint, targetAt, toleranceMs: cfg.toleranceMs, notBeforeTarget: true });
      }
    }

    const migrationAt = migrationByMint.get(token.mint) ?? null;
    if (migrationAt != null && migrationAt >= nowMs - (TEMPORAL_RETENTION_DAYS * 86_400_000 + 24 * 60 * 60_000)) {
      lookupTargets.push({ key: `migration:${token.mint}:anchor`, mint: token.mint, targetAt: migrationAt, toleranceMs: 5 * 60_000, notBeforeTarget: true });
      for (const horizon of POST_MIGRATION_HORIZONS) {
        const cfg = DEV_OUTCOME_CONFIG[horizon];
        const targetAt = migrationAt + cfg.offsetMs;
        if (targetAt <= nowMs) lookupTargets.push({ key: `migration:${token.mint}:${horizon}`, mint: token.mint, targetAt, toleranceMs: cfg.toleranceMs, notBeforeTarget: true });
      }
    }
  }

  const temporalByKey = new Map(
    getNearestChainTemporalSnapshots(lookupTargets).map((row) => [row.key, row.snapshot] as const),
  );
  const outcomeTokens: DevOutcomeTokenInput[] = previousTokens.map((token) => {
    const launchAt = normalizeTimestampMs(token.createdAt);
    let launchAnchor = temporalPoint(temporalByKey.get(`launch:${token.mint}:anchor`));
    if (launchAnchor && launchAt != null && launchAnchor.observedAt < launchAt - 30_000) launchAnchor = null;
    const launchTargets: DevOutcomeTokenInput["launchTargets"] = {};
    for (const horizon of Object.keys(DEV_OUTCOME_CONFIG) as DevOutcomeHorizon[]) {
      launchTargets[horizon] = temporalPoint(temporalByKey.get(`launch:${token.mint}:${horizon}`));
    }
    const migrationAtMs = migrationByMint.get(token.mint) ?? null;
    const migrationTargets: NonNullable<DevOutcomeTokenInput["migrationTargets"]> = {};
    for (const horizon of POST_MIGRATION_HORIZONS) {
      migrationTargets[horizon] = temporalPoint(temporalByKey.get(`migration:${token.mint}:${horizon}`));
    }
    let migrationAnchor = temporalPoint(temporalByKey.get(`migration:${token.mint}:anchor`));
    if (migrationAnchor && migrationAtMs != null && migrationAnchor.observedAt < migrationAtMs - 30_000) migrationAnchor = null;
    return {
      mint: token.mint,
      symbol: token.symbol ?? null,
      createdAt: token.createdAt,
      athUsd: token.athUsd ?? null,
      totalSupply: null,
      launchAnchor,
      launchTargets,
      migrationAt: migrationAtMs == null ? null : migrationAtMs / 1000,
      migrationAnchor,
      migrationTargets,
    };
  });

  const outcomes = computeDevOutcomeAnalytics({
    tokens: outcomeTokens,
    nowMs,
    retentionDays: TEMPORAL_RETENTION_DAYS,
  });

  return {
    available: true,
    creator,
    mint,
    fetchedAt,
    source,
    warning,
    analytics,
    outcomes,
    forensics: {
      available: latestForensics != null,
      analyzedAt: latestForensics?.analyzedAt ?? null,
      medianLifespanHours,
      averageLifespanHours,
      over24hSurvivalRate: lifespanObserved > 0 ? over24hCount / lifespanObserved : null,
      lifespanObserved,
      lifespanCoverage: analytics.previousLaunches > 0 ? lifespanObserved / analytics.previousLaunches : 0,
    },
  };
}
