import { test } from "node:test";
import assert from "node:assert/strict";
import { metrics } from "../src/core/metrics";
import {
  PRIORITY_CONFIG, SIGNAL_CONFIG, WEIGHTED_CONFIG,
  totalWeight, totalWeightedWeight,
} from "../src/intelligence/signals/config";
import { calculatePriority, isGrowthSignal } from "../src/intelligence/signals/priority";
import {
  calculateWeightedSignal, resolveWeightedLevel, trendStrengthPercent,
  type WeightedSignalContext,
} from "../src/intelligence/signals/weighted-scorer";
import {
  applyAuthorInfluence, applyWeightedScoring, buildSignal,
  type EntitySignalMetrics,
} from "../src/intelligence/signals/detector";

const NOW = Date.now();
const HOURS = SIGNAL_CONFIG.windowHours;

function context(over: Partial<WeightedSignalContext> = {}): WeightedSignalContext {
  return { influenceScore: 0, uniqueAuthors: 4, trend: 0, velocity: 0.5, ...over };
}

test("weighted: веса v2 = 1, уровни 40/70/85, веса v1 не тронуты", () => {
  assert.ok(Math.abs(totalWeightedWeight() - 1) < 1e-9);
  assert.equal(WEIGHTED_CONFIG.weights.baseSignal, 0.6);
  assert.equal(WEIGHTED_CONFIG.weights.authorInfluence, 0.25);
  assert.equal(WEIGHTED_CONFIG.weights.trendStrength, 0.15);
  assert.deepEqual(WEIGHTED_CONFIG.levels, { medium: 40, high: 70, critical: 85 });
  // v1 не изменился
  assert.equal(totalWeight(), 100);
  assert.deepEqual(SIGNAL_CONFIG.levels, { medium: 50, high: 70, critical: 85 });
  assert.equal(PRIORITY_CONFIG.kolThreshold, 60);
  assert.equal(PRIORITY_CONFIG.growthPercent, 10);
});

test("weighted: обычный сигнал без KOL и тренда → только базовый вклад", () => {
  const w = calculateWeightedSignal(
    { entity: "BTC", score: 62, level: "HIGH" },
    context(),
  );
  assert.equal(w.baseScore, 62);
  assert.deepEqual(w.factors, { baseSignal: 37, authorInfluence: 0, trendStrength: 0 });
  assert.equal(w.weightedScore, 37);
  assert.equal(w.factors.baseSignal + w.factors.authorInfluence + w.factors.trendStrength, w.weightedScore);
  assert.equal(w.level, "LOW");
});

test("weighted: KOL + rising тренд поднимает weightedScore", () => {
  const plain = calculateWeightedSignal(
    { entity: "BTC", score: 62, level: "HIGH" },
    context(),
  );
  const kol = calculateWeightedSignal(
    { entity: "BTC", score: 62, level: "HIGH" },
    context({ influenceScore: 85, trend: "rising", uniqueAuthors: 7, velocity: 1 }),
  );
  assert.deepEqual(kol.factors, { baseSignal: 37, authorInfluence: 21, trendStrength: 15 });
  assert.equal(kol.weightedScore, 73);
  assert.equal(kol.level, "HIGH");
  assert.ok(kol.weightedScore > plain.weightedScore);
});

test("weighted: без KOL influence не даёт баллов, тренд даёт", () => {
  const trendOnly = calculateWeightedSignal(
    { entity: "ETH", score: 62, level: "HIGH" },
    context({ influenceScore: 0, trend: 100 }),
  );
  assert.deepEqual(trendOnly.factors, { baseSignal: 37, authorInfluence: 0, trendStrength: 15 });
  assert.equal(trendOnly.weightedScore, 52);
  assert.equal(trendOnly.level, "MEDIUM");
});

test("weighted: level mapping — границы 40/70/85", () => {
  assert.equal(resolveWeightedLevel(0), "LOW");
  assert.equal(resolveWeightedLevel(39), "LOW");
  assert.equal(resolveWeightedLevel(40), "MEDIUM");
  assert.equal(resolveWeightedLevel(69), "MEDIUM");
  assert.equal(resolveWeightedLevel(70), "HIGH");
  assert.equal(resolveWeightedLevel(84), "HIGH");
  assert.equal(resolveWeightedLevel(85), "CRITICAL");
  assert.equal(resolveWeightedLevel(100), "CRITICAL");
});

test("weighted: тренд → trendStrength, cap и мусор на входе", () => {
  assert.equal(trendStrengthPercent("rising"), 100);
  assert.equal(trendStrengthPercent("stable"), 0);
  assert.equal(trendStrengthPercent("falling"), 0);
  assert.equal(trendStrengthPercent(400), 100);
  assert.equal(trendStrengthPercent(50), 50);
  assert.equal(trendStrengthPercent(-10), 0);
  assert.equal(trendStrengthPercent(Number.NaN), 0);

  const garbage = calculateWeightedSignal(
    { entity: "BAD", score: Number.NaN, level: "LOW" },
    context({ influenceScore: Number.POSITIVE_INFINITY, trend: -5, velocity: Number.NaN }),
  );
  assert.deepEqual(garbage.factors, { baseSignal: 0, authorInfluence: 0, trendStrength: 0 });
  assert.equal(garbage.weightedScore, 0);
  assert.equal(garbage.level, "LOW");

  const capped = calculateWeightedSignal(
    { entity: "CAP", score: 200, level: "CRITICAL" },
    context({ influenceScore: 150 }),
  );
  assert.deepEqual(capped.factors, { baseSignal: 60, authorInfluence: 25, trendStrength: 0 });
  assert.equal(capped.weightedScore, 85);
  assert.equal(capped.level, "CRITICAL");
});

test("priority: CRITICAL + KOL → URGENT", () => {
  const p = calculatePriority({ level: "CRITICAL", kolInfluence: 91, trend: "rising" });
  assert.equal(p.priority, "URGENT");
  assert.match(p.reason, /CRITICAL/);
  assert.match(p.reason, /KOL/);

  // KOL ниже порога детектора — KOL не считается
  const below = calculatePriority({ level: "CRITICAL", kolInfluence: 50 });
  assert.equal(below.priority, "IMPORTANT");
});

test("priority: HIGH + growth / KOL → IMPORTANT, без динамики → NORMAL", () => {
  assert.equal(calculatePriority({ level: "HIGH", trend: "rising" }).priority, "IMPORTANT");
  assert.equal(calculatePriority({ level: "HIGH", trend: 400 }).priority, "IMPORTANT");
  assert.equal(calculatePriority({ level: "HIGH", kolInfluence: 85 }).priority, "IMPORTANT");
  assert.equal(calculatePriority({ level: "HIGH" }).priority, "NORMAL");
  assert.equal(calculatePriority({ level: "CRITICAL" }).priority, "IMPORTANT");
  assert.equal(calculatePriority({ level: "MEDIUM" }).priority, "NORMAL");
  assert.equal(calculatePriority({ level: "LOW", kolInfluence: 91, trend: "rising" }).priority, "LOW");
});

test("priority: growth-порог совпадает со стабильностью тренда", () => {
  assert.equal(isGrowthSignal(undefined), false);
  assert.equal(isGrowthSignal("rising"), true);
  assert.equal(isGrowthSignal("stable"), false);
  assert.equal(isGrowthSignal(9), false);
  assert.equal(isGrowthSignal(10), true);
  assert.equal(isGrowthSignal(-50), false);
  assert.equal(isGrowthSignal(Number.NaN), false);
});

test("detector: applyWeightedScoring не меняет score v1 и добавляет metadata v2", () => {
  const row: EntitySignalMetrics = {
    entityType: "TOKEN",
    value: "BTC",
    currentMentions: 10,
    previousMentions: 2,
    uniqueAuthors: 5,
    firstSeen: NOW - 3_600_000,
    authors: ["kol_top"],
  };
  const signals = [buildSignal(row, { hours: HOURS, now: NOW, minScore: 0, config: SIGNAL_CONFIG })];
  const before = { score: signals[0].score, factors: { ...signals[0].factors }, level: signals[0].level };

  applyAuthorInfluence(signals, [row], new Map([["kol_top", 91]]));
  const wBefore = metrics.weightedSignalsCalculated;
  const pBefore = metrics.prioritySignalsCreated;
  applyWeightedScoring(signals);

  const s = signals[0];
  const m = s.metadata;
  // v1 не тронут
  assert.equal(s.score, before.score);
  assert.equal(s.score, 88);
  assert.deepEqual(s.factors, before.factors);
  assert.equal(s.level, before.level);
  // v2 слой
  assert.equal(m.baseScore, 88);
  assert.equal(m.weightedScore, 91); // 53 + 23 + 15
  assert.equal(m.kolInfluence, 91);
  assert.equal(m.priority, "URGENT");
  assert.equal(m.entity_type, "TOKEN");
  assert.equal(m.current_mentions, 10);
  assert.equal(metrics.weightedSignalsCalculated, wBefore + 1);
  assert.equal(metrics.prioritySignalsCreated, pBefore + 1);
});

test("detector: без KOL — kolInfluence 0, приоритет не URGENT", () => {
  const row: EntitySignalMetrics = {
    entityType: "TOKEN",
    value: "SOL",
    currentMentions: 10,
    previousMentions: 2,
    uniqueAuthors: 5,
    firstSeen: NOW - 3_600_000,
    authors: ["randomguy"],
  };
  const signals = [buildSignal(row, { hours: HOURS, now: NOW, minScore: 0, config: SIGNAL_CONFIG })];
  applyAuthorInfluence(signals, [row], new Map([["kol_top", 91]]));
  applyWeightedScoring(signals);

  const m = signals[0].metadata;
  assert.equal(m.kolDetected, false);
  assert.deepEqual(m.authors, []);
  assert.equal(signals[0].authorInfluence, undefined);
  assert.equal(m.kolInfluence, 0);
  assert.equal(m.weightedScore, 68); // 53 + 0 + 15
  assert.equal(m.priority, "NORMAL");
});

test("detector: applyWeightedScoring пустой список — no-op", () => {
  const wBefore = metrics.weightedSignalsCalculated;
  const pBefore = metrics.prioritySignalsCreated;
  applyWeightedScoring([]);
  assert.equal(metrics.weightedSignalsCalculated, wBefore);
  assert.equal(metrics.prioritySignalsCreated, pBefore);
});
