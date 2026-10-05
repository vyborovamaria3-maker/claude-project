import assert from "node:assert/strict";
import { computeDevHistoryAnalytics, computeDevOutcomeAnalytics, type DevHistoryTokenInput, type DevOutcomeTokenInput } from "../lib/trade/dev-history.ts";

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log(`PASS ${passed}: ${name}`); };

const token = (i: number, overrides: Partial<DevHistoryTokenInput> = {}): DevHistoryTokenInput => ({
  mint: `M${i}`, symbol: `T${i}`, name: `Token ${i}`,
  createdAt: 1_700_000_000 + i * 3600, marketCapUsd: 10_000, athUsd: 20_000,
  isMigrated: false, reached300k: false, totalSupply: 1_000_000_000, ...overrides,
});
const point = (observedAt: number, priceUsd: number | null, liquidityUsd: number | null = 100_000, marketCapUsd: number | null = null) => ({ observedAt, priceUsd, liquidityUsd, marketCapUsd });
const C = 1_700_000_000, MS = C * 1000;
const outcomeToken = (overrides: Partial<DevOutcomeTokenInput> = {}): DevOutcomeTokenInput => ({
  mint: "OUT", symbol: "OUT", createdAt: C, athUsd: 1_000_000, totalSupply: 1_000_000_000,
  launchAnchor: point(MS, 0.0001, 100_000, 100_000),
  launchTargets: {
    "5m": point(MS + 300_000, 0.00012, 120_000, 120_000),
    "15m": point(MS + 900_000, 0.00008, 90_000, 80_000),
    "1h": point(MS + 3_600_000, 0.0002, 180_000, 200_000),
    "6h": point(MS + 21_600_000, 0.00005, 50_000, 50_000),
    "24h": point(MS + 86_400_000, 0.00003, 30_000, 30_000),
  },
  migrationAt: C + 1800,
  migrationAnchor: point(MS + 1_800_000, 0.00015, 150_000),
  migrationTargets: {
    "1h": point(MS + 5_400_000, 0.00018, 180_000),
    "6h": point(MS + 23_400_000, 0.0001, 80_000),
    "24h": point(MS + 88_200_000, null, 0),
  },
  ...overrides,
});

test("current mint excluded", () => {
  const out = computeDevHistoryAnalytics({ tokens: [token(1), token(2, { athUsd: 2_000_000 })], currentMint: "M2", nowSec: 1_800_000_000 });
  assert.equal(out.previousLaunches, 1); assert.equal(out.ath.maxUsd, 20_000);
});
test("unknown ATH not failure", () => {
  const out = computeDevHistoryAnalytics({ tokens: [token(1, { athUsd: null }), token(2, { athUsd: 120_000 })], nowSec: 1_800_000_000 });
  assert.equal(out.thresholds.reached100k.observedCount, 1); assert.equal(out.thresholds.reached100k.rate, 1);
});
test("affirmative 300k evidence", () => {
  const out = computeDevHistoryAnalytics({ tokens: [token(1, { athUsd: null, reached300k: true })], nowSec: 1_800_000_000 });
  assert.equal(out.thresholds.reached300k.rate, 1); assert.equal(out.thresholds.reached1m.rate, null);
});
test("future launch excluded from cadence", () => {
  const now = 1_700_100_000; const out = computeDevHistoryAnalytics({ tokens: [token(1, { createdAt: now - 7200 }), token(2, { createdAt: now - 3600 }), token(3, { createdAt: now + 3600 })], nowSec: now });
  assert.equal(out.cadence.observedLaunches, 2); assert.equal(out.cadence.medianIntervalSec, 3600);
});
test("missing outcome target remains unknown", () => {
  const base = outcomeToken(); const missing = outcomeToken({ mint: "MISS", launchTargets: { ...base.launchTargets, "5m": null } });
  const out = computeDevOutcomeAnalytics({ tokens: [base, missing], nowMs: 1_800_000_000_000 });
  assert.equal(out.horizons["5m"].eligibleLaunches, 2); assert.equal(out.horizons["5m"].samples, 1); assert.equal(out.horizons["5m"].coverage, 0.5);
});
test("launch return math", () => {
  const out = computeDevOutcomeAnalytics({ tokens: [outcomeToken()], nowMs: 1_800_000_000_000 });
  assert.ok(Math.abs((out.horizons["5m"].medianReturnPct ?? 0) - 20) < 1e-8);
});
test("24h recorded ATH drawdown", () => {
  const out = computeDevOutcomeAnalytics({ tokens: [outcomeToken()], nowMs: 1_800_000_000_000 });
  assert.ok(Math.abs((out.horizons["24h"].medianRecordedAthDrawdownPct ?? 0) - 97) < 1e-8);
});
test("stale ATH conflict excluded", () => {
  const out = computeDevOutcomeAnalytics({ tokens: [outcomeToken({ athUsd: 20_000 })], nowMs: 1_800_000_000_000 });
  assert.equal(out.horizons["1h"].medianRecordedAthDrawdownPct, null); assert.equal(out.horizons["1h"].staleAthConflictCount, 1);
});
test("missing migration evidence not dead", () => {
  const t = outcomeToken({ migrationTargets: { "1h": null, "6h": point(MS + 23_400_000, 0.0001, null), "24h": point(MS + 88_200_000, null, 0) } });
  const out = computeDevOutcomeAnalytics({ tokens: [t], nowMs: 1_800_000_000_000 });
  assert.equal(out.postMigration.horizons["1h"].survivalObserved, 0); assert.equal(out.postMigration.horizons["6h"].survivalObserved, 0); assert.equal(out.postMigration.horizons["24h"].explicitDeadCount, 1);
});
test("not-yet-mature horizon not eligible", () => {
  const out = computeDevOutcomeAnalytics({ tokens: [outcomeToken()], nowMs: MS + 10 * 60_000 });
  assert.equal(out.horizons["5m"].eligibleLaunches, 1); assert.equal(out.horizons["15m"].eligibleLaunches, 0); assert.equal(out.horizons["24h"].eligibleLaunches, 0);
});
test("millisecond createdAt supported", () => {
  const out = computeDevOutcomeAnalytics({ tokens: [outcomeToken({ createdAt: MS })], nowMs: MS + 7 * 60_000 });
  assert.equal(out.horizons["5m"].eligibleLaunches, 1); assert.equal(out.horizons["15m"].eligibleLaunches, 0);
});
test("no NaN/Infinity in headline outcome stats", () => {
  const out = computeDevOutcomeAnalytics({ tokens: [outcomeToken()], nowMs: 1_800_000_000_000 });
  for (const row of Object.values(out.horizons)) {
    for (const v of [row.meanReturnPct, row.medianReturnPct, row.p25ReturnPct, row.p75ReturnPct, row.positiveReturnRate, row.medianRecordedAthDrawdownPct]) {
      assert.ok(v == null || Number.isFinite(v));
    }
  }
});

test("future-dated token cannot contaminate historical creator stats", () => {
  const now = 1_700_100_000;
  const out = computeDevHistoryAnalytics({
    tokens: [
      token(1, { createdAt: now - 3600, athUsd: 20_000 }),
      token(2, { createdAt: now + 3600, athUsd: 2_000_000, isMigrated: true }),
    ],
    nowSec: now,
  });
  assert.equal(out.previousLaunches, 1);
  assert.equal(out.ath.maxUsd, 20_000);
  assert.deepEqual(out.recentLaunches.map((row) => row.mint), ["M1"]);
});

test("millisecond launch timestamps normalize in DEV History V2 analytics", () => {
  const now = 1_800_000_000;
  const out = computeDevHistoryAnalytics({ tokens: [token(1, { createdAt: (now - 3600) * 1000 })], nowSec: now });
  assert.equal(out.cadence.observedLaunches, 1);
  assert.equal(out.recentLaunches[0]?.createdAt, now - 3600);
});

test("pre-migration anchor is rejected", () => {
  const migrationAt = C + 1800;
  const t = outcomeToken({
    migrationAt,
    migrationAnchor: point((migrationAt * 1000) - 120_000, 0.0001, 100_000),
  });
  const out = computeDevOutcomeAnalytics({ tokens: [t], nowMs: 1_800_000_000_000 });
  assert.equal(out.postMigration.migrationAnchorObserved, 0);
  assert.equal(out.postMigration.horizons["1h"].returnSamples, 0);
});

test("future temporal target is rejected even if event horizon matured", () => {
  const nowMs = MS + 2 * 60 * 60_000;
  const t = outcomeToken({
    launchTargets: {
      ...outcomeToken().launchTargets,
      "1h": point(nowMs + 60_000, 0.0002, 100_000),
    },
  });
  const out = computeDevOutcomeAnalytics({ tokens: [t], nowMs });
  assert.equal(out.horizons["1h"].eligibleLaunches, 1);
  assert.equal(out.horizons["1h"].samples, 0);
});

test("retention coverage is separate from lifetime evidence coverage", () => {
  const nowMs = MS + 40 * 86_400_000;
  const old = outcomeToken({ mint: "OLD", createdAt: C });
  const recentCreated = Math.floor((nowMs - 2 * 86_400_000) / 1000);
  const recentMs = recentCreated * 1000;
  const recent = outcomeToken({
    mint: "RECENT",
    createdAt: recentCreated,
    launchAnchor: point(recentMs, 1, 100_000),
    launchTargets: { "5m": point(recentMs + 300_000, 1.1, 100_000) },
  });
  const out = computeDevOutcomeAnalytics({ tokens: [old, recent], nowMs, retentionDays: 14 });
  assert.equal(out.horizons["5m"].eligibleLaunches, 2);
  assert.equal(out.horizons["5m"].retentionEligibleLaunches, 1);
  assert.equal(out.horizons["5m"].retentionCoverage, 1);
  assert.equal(out.horizons["5m"].coverage, 1);
});

test("pre-horizon temporal target cannot label a later horizon", () => {
  const t = outcomeToken({
    launchTargets: {
      ...outcomeToken().launchTargets,
      "5m": point(MS + 4 * 60_000, 0.00012, 100_000),
    },
  });
  const out = computeDevOutcomeAnalytics({ tokens: [t], nowMs: 1_800_000_000_000 });
  assert.equal(out.horizons["5m"].samples, 0);
});

test("positive price plus zero liquidity is contradiction, not explicit death", () => {
  const t = outcomeToken({
    migrationTargets: {
      "1h": point(MS + 5_400_000, 0.00018, 0),
      "6h": null,
      "24h": null,
    },
  });
  const out = computeDevOutcomeAnalytics({ tokens: [t], nowMs: 1_800_000_000_000 });
  const row = out.postMigration.horizons["1h"];
  assert.equal(row.explicitDeadCount, 0);
  assert.equal(row.survivalConflictCount, 1);
  assert.equal(row.survivalRate, null);
});

console.log(`DEV_HISTORY_V3_REGRESSION_PASS=${passed}/${passed}`);
