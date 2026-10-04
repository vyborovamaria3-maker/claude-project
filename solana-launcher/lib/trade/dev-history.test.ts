import { describe, expect, it } from "vitest";
import { computeDevHistoryAnalytics, type DevHistoryTokenInput } from "./dev-history";

function token(i: number, overrides: Partial<DevHistoryTokenInput> = {}): DevHistoryTokenInput {
  return {
    mint: `M${i}`,
    symbol: `T${i}`,
    name: `Token ${i}`,
    createdAt: 1_700_000_000 + i * 3600,
    marketCapUsd: 10_000,
    athUsd: 20_000,
    isMigrated: false,
    reached300k: false,
    ...overrides,
  };
}

describe("DEV History V2", () => {
  it("excludes the current mint from prior-launch statistics", () => {
    const out = computeDevHistoryAnalytics({
      tokens: [token(1), token(2, { athUsd: 2_000_000 })],
      currentMint: "M2",
      nowSec: 1_800_000_000,
    });
    expect(out.previousLaunches).toBe(1);
    expect(out.ath.maxUsd).toBe(20_000);
  });

  it("never treats unknown ATH as a failed threshold outcome", () => {
    const out = computeDevHistoryAnalytics({
      tokens: [token(1, { athUsd: null, reached300k: false }), token(2, { athUsd: 120_000 })],
      nowSec: 1_800_000_000,
    });
    expect(out.thresholds.reached100k.observedCount).toBe(1);
    expect(out.thresholds.reached100k.successCount).toBe(1);
    expect(out.thresholds.reached100k.rate).toBe(1);
  });

  it("uses affirmative reached300k evidence when exact ATH is missing", () => {
    const out = computeDevHistoryAnalytics({
      tokens: [token(1, { athUsd: null, reached300k: true })],
      nowSec: 1_800_000_000,
    });
    expect(out.thresholds.reached100k.rate).toBe(1);
    expect(out.thresholds.reached300k.rate).toBe(1);
    expect(out.thresholds.reached1m.rate).toBeNull();
  });

  it("computes ATH distribution only from exact observed ATH values", () => {
    const out = computeDevHistoryAnalytics({
      tokens: [
        token(1, { athUsd: 10_000 }),
        token(2, { athUsd: 50_000 }),
        token(3, { athUsd: 150_000 }),
        token(4, { athUsd: 500_000 }),
        token(5, { athUsd: 2_000_000 }),
        token(6, { athUsd: null }),
      ],
      nowSec: 1_800_000_000,
    });
    expect(out.ath.observedCount).toBe(5);
    expect(out.distribution.map((row) => row.count)).toEqual([1, 1, 1, 1, 1]);
  });

  it("computes cadence without future timestamps", () => {
    const nowSec = 1_700_100_000;
    const out = computeDevHistoryAnalytics({
      tokens: [
        token(1, { createdAt: nowSec - 7200 }),
        token(2, { createdAt: nowSec - 3600 }),
        token(3, { createdAt: nowSec + 3600 }),
      ],
      nowSec,
    });
    expect(out.cadence.observedLaunches).toBe(2);
    expect(out.cadence.medianIntervalSec).toBe(3600);
  });

  it("detects improving recent creator performance only with usable evidence", () => {
    const tokens = Array.from({ length: 20 }, (_, i) => token(i, {
      createdAt: 1_700_000_000 + i * 3600,
      athUsd: i >= 10 ? 500_000 : 20_000,
    }));
    const out = computeDevHistoryAnalytics({ tokens, nowSec: 1_800_000_000 });
    expect(out.trend.state).toBe("improving");
  });


  it("lets affirmative reached300k evidence override a stale lower ATH", () => {
    const out = computeDevHistoryAnalytics({
      tokens: [token(1, { athUsd: 50_000, reached300k: true })],
      nowSec: 1_800_000_000,
    });
    expect(out.thresholds.reached300k.rate).toBe(1);
    expect(out.ath.observedCount).toBe(0);
  });

  it("does not call a conflicting trend improving or declining", () => {
    const tokens = Array.from({ length: 20 }, (_, i) => token(i, {
      createdAt: 1_700_000_000 + i * 3600,
      athUsd: i >= 10 ? (i < 16 ? 500_000 : 20_000) : 100_000,
    }));
    const out = computeDevHistoryAnalytics({ tokens, nowSec: 1_800_000_000 });
    // Recent median is much stronger, while recent $100k hit-rate is materially worse.
    expect(out.trend.state).toBe("unknown");
  });

  it("keeps recurring-wallet coverage explicit", () => {
    const out = computeDevHistoryAnalytics({
      tokens: [token(1), token(2), token(3), token(4)],
      recurringCoveredTokens: 2,
      recurringWallets: [{ wallet: "W", tokenCount: 2, tradeCount: 4, volumeSol: 12, firstSeen: 10, lastSeen: 20 }],
      nowSec: 1_800_000_000,
    });
    expect(out.recurringNetwork.coverage).toBe(0.5);
    expect(out.recurringNetwork.wallets[0].tokenCount).toBe(2);
  });
});

import { computeDevOutcomeAnalytics, type DevOutcomeTokenInput } from "./dev-history";

function point(at: number, priceUsd: number | null, liquidityUsd: number | null = 100_000, marketCapUsd?: number | null) {
  return { observedAt: at, priceUsd, liquidityUsd, marketCapUsd };
}

function outcomeToken(overrides: Partial<DevOutcomeTokenInput> = {}): DevOutcomeTokenInput {
  const createdAt = 1_700_000_000;
  const createdMs = createdAt * 1000;
  return {
    mint: "OUTCOME",
    symbol: "OUT",
    createdAt,
    athUsd: 1_000_000,
    totalSupply: 1_000_000_000,
    launchAnchor: point(createdMs, 0.0001, 100_000, 100_000),
    launchTargets: {
      "5m": point(createdMs + 5 * 60_000, 0.00012, 120_000, 120_000),
      "15m": point(createdMs + 15 * 60_000, 0.00008, 90_000, 80_000),
      "1h": point(createdMs + 60 * 60_000, 0.0002, 180_000, 200_000),
      "6h": point(createdMs + 6 * 60 * 60_000, 0.00005, 50_000, 50_000),
      "24h": point(createdMs + 24 * 60 * 60_000, 0.00003, 30_000, 30_000),
    },
    migrationAt: createdAt + 30 * 60,
    migrationAnchor: point(createdMs + 30 * 60_000, 0.00015, 150_000),
    migrationTargets: {
      "1h": point(createdMs + 90 * 60_000, 0.00018, 180_000),
      "6h": point(createdMs + 6.5 * 60 * 60_000, 0.0001, 80_000),
      "24h": point(createdMs + 24.5 * 60 * 60_000, null, 0),
    },
    ...overrides,
  };
}

describe("DEV History V3 outcomes", () => {
  it("computes launch returns without turning missing targets into zero", () => {
    const full = outcomeToken();
    const missing = outcomeToken({ mint: "MISSING", launchTargets: { ...full.launchTargets, "5m": null } });
    const out = computeDevOutcomeAnalytics({ tokens: [full, missing], nowMs: 1_800_000_000_000 });
    expect(out.horizons["5m"].eligibleLaunches).toBe(2);
    expect(out.horizons["5m"].samples).toBe(1);
    expect(out.horizons["5m"].coverage).toBe(0.5);
    expect(out.horizons["5m"].medianReturnPct).toBeCloseTo(20, 8);
  });

  it("computes recorded ATH drawdown only when market cap evidence is compatible", () => {
    const out = computeDevOutcomeAnalytics({ tokens: [outcomeToken()], nowMs: 1_800_000_000_000 });
    expect(out.horizons["24h"].medianRecordedAthDrawdownPct).toBeCloseTo(97, 8);
    expect(out.horizons["24h"].recordedAthDrawdownSamples).toBe(1);
  });

  it("excludes stale ATH conflicts instead of producing negative drawdown", () => {
    const t = outcomeToken({ athUsd: 20_000 });
    const out = computeDevOutcomeAnalytics({ tokens: [t], nowMs: 1_800_000_000_000 });
    expect(out.horizons["1h"].medianRecordedAthDrawdownPct).toBeNull();
    expect(out.horizons["1h"].staleAthConflictCount).toBe(1);
  });

  it("does not classify missing post-migration evidence as dead", () => {
    const t = outcomeToken({
      migrationTargets: {
        "1h": null,
        "6h": point(1_700_000_000_000 + 6.5 * 60 * 60_000, 0.0001, null),
        "24h": point(1_700_000_000_000 + 24.5 * 60 * 60_000, null, 0),
      },
    });
    const out = computeDevOutcomeAnalytics({ tokens: [t], nowMs: 1_800_000_000_000 });
    expect(out.postMigration.horizons["1h"].survivalObserved).toBe(0);
    expect(out.postMigration.horizons["1h"].survivalRate).toBeNull();
    expect(out.postMigration.horizons["6h"].survivalObserved).toBe(0);
    expect(out.postMigration.horizons["24h"].explicitDeadCount).toBe(1);
    expect(out.postMigration.horizons["24h"].survivalRate).toBe(0);
  });

  it("does not make a not-yet-mature horizon eligible", () => {
    const nowMs = 1_700_000_000_000 + 10 * 60_000;
    const out = computeDevOutcomeAnalytics({ tokens: [outcomeToken()], nowMs });
    expect(out.horizons["5m"].eligibleLaunches).toBe(1);
    expect(out.horizons["15m"].eligibleLaunches).toBe(0);
    expect(out.horizons["24h"].eligibleLaunches).toBe(0);
  });
});

describe("DEV History V3.0.1 adversarial hardening", () => {
  it("excludes future-dated tokens from historical creator performance", () => {
    const nowSec = 1_700_100_000;
    const out = computeDevHistoryAnalytics({
      tokens: [
        token(1, { createdAt: nowSec - 3600, athUsd: 20_000 }),
        token(2, { createdAt: nowSec + 3600, athUsd: 2_000_000, isMigrated: true }),
      ],
      nowSec,
    });
    expect(out.previousLaunches).toBe(1);
    expect(out.ath.maxUsd).toBe(20_000);
  });

  it("rejects a launch target before the named forward horizon", () => {
    const t = outcomeToken({
      launchTargets: {
        ...outcomeToken().launchTargets,
        "5m": point(1_700_000_000_000 + 4 * 60_000, 0.00012, 100_000),
      },
    });
    const out = computeDevOutcomeAnalytics({ tokens: [t], nowMs: 1_800_000_000_000 });
    expect(out.horizons["5m"].samples).toBe(0);
  });

  it("rejects a pre-migration price anchor", () => {
    const migrationAt = 1_700_000_000 + 1800;
    const t = outcomeToken({
      migrationAt,
      migrationAnchor: point(migrationAt * 1000 - 120_000, 0.0001, 100_000),
    });
    const out = computeDevOutcomeAnalytics({ tokens: [t], nowMs: 1_800_000_000_000 });
    expect(out.postMigration.migrationAnchorObserved).toBe(0);
    expect(out.postMigration.horizons["1h"].returnSamples).toBe(0);
  });

  it("separates retention-window coverage from lifetime evidence coverage", () => {
    const baseMs = 1_700_000_000_000;
    const nowMs = baseMs + 40 * 86_400_000;
    const old = outcomeToken({ mint: "OLD", createdAt: 1_700_000_000 });
    const recentCreated = Math.floor((nowMs - 2 * 86_400_000) / 1000);
    const recentMs = recentCreated * 1000;
    const recent = outcomeToken({
      mint: "RECENT",
      createdAt: recentCreated,
      launchAnchor: point(recentMs, 1, 100_000),
      launchTargets: { "5m": point(recentMs + 300_000, 1.1, 100_000) },
    });
    const out = computeDevOutcomeAnalytics({ tokens: [old, recent], nowMs, retentionDays: 14 });
    expect(out.horizons["5m"].eligibleLaunches).toBe(2);
    expect(out.horizons["5m"].retentionEligibleLaunches).toBe(1);
    expect(out.horizons["5m"].retentionCoverage).toBe(1);
  });

  it("treats positive price plus zero liquidity as contradictory, not explicit death", () => {
    const t = outcomeToken({
      migrationTargets: {
        "1h": point(1_700_000_000_000 + 5_400_000, 0.00018, 0),
        "6h": null,
        "24h": null,
      },
    });
    const out = computeDevOutcomeAnalytics({ tokens: [t], nowMs: 1_800_000_000_000 });
    const row = out.postMigration.horizons["1h"];
    expect(row.explicitDeadCount).toBe(0);
    expect(row.survivalConflictCount).toBe(1);
    expect(row.survivalRate).toBeNull();
  });
});
