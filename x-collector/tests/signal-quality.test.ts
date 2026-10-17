import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareSignalQuality,
  splitSignalOutcomes,
  summarizeSignalQuality,
  type SignalQualityOutcome,
} from "../src/intelligence/signals/quality";

function row(
  signal_at: number,
  score: number,
  outcome_status: string,
  attention_change_pct: number | null,
): SignalQualityOutcome {
  return { signal_at, score, outcome_status, attention_change_pct };
}

const outcomes = [
  row(1, 80, "ready", 50),
  row(2, 90, "ready", 30),
  row(3, 40, "ready", -10),
  row(4, 20, "ready", -20),
  row(5, 85, "missing_exit", null),
  row(6, 55, "low_baseline", null),
];

test("signal quality counts unavailable outcomes in coverage denominator, not outcome metrics", () => {
  const summary = summarizeSignalQuality(outcomes);
  assert.equal(summary.totalSignals, 6);
  assert.equal(summary.readyOutcomes, 4);
  assert.equal(summary.coveragePct, 66.67);
  assert.equal(summary.averageAttentionChangePct, 12.5);
  assert.equal(summary.medianAttentionChangePct, 10);
  assert.equal(summary.positiveAttentionRatePct, 50);
});

test("signal quality compares a frozen threshold cohort with below-threshold baseline", () => {
  const comparison = compareSignalQuality(outcomes, 60);
  assert.equal(comparison.selected.totalSignals, 3);
  assert.equal(comparison.selected.readyOutcomes, 2);
  assert.equal(comparison.selected.averageAttentionChangePct, 40);
  assert.equal(comparison.selected.positiveAttentionRatePct, 100);
  assert.equal(comparison.baseline.totalSignals, 3);
  assert.equal(comparison.baseline.readyOutcomes, 2);
  assert.equal(comparison.baseline.averageAttentionChangePct, -15);
  assert.equal(comparison.baseline.positiveAttentionRatePct, 0);
  assert.equal(comparison.averageChangeLiftPct, 55);
  assert.equal(comparison.positiveRateLiftPct, 100);
});

test("signal quality returns null metrics for empty or unavailable cohorts", () => {
  assert.deepEqual(summarizeSignalQuality([]), {
    totalSignals: 0,
    readyOutcomes: 0,
    coveragePct: null,
    averageAttentionChangePct: null,
    medianAttentionChangePct: null,
    positiveAttentionRatePct: null,
  });
  const unavailable = summarizeSignalQuality([row(1, 70, "pending", null)]);
  assert.equal(unavailable.totalSignals, 1);
  assert.equal(unavailable.readyOutcomes, 0);
  assert.equal(unavailable.coveragePct, 0);
  assert.equal(unavailable.averageAttentionChangePct, null);
});

test("signal quality split is chronological and puts the split boundary in test", () => {
  const split = splitSignalOutcomes(outcomes, 4);
  assert.deepEqual(split.train.map((item) => item.signal_at), [1, 2, 3]);
  assert.deepEqual(split.test.map((item) => item.signal_at), [4, 5, 6]);
});

test("signal quality rejects invalid thresholds and split timestamps", () => {
  assert.throws(() => compareSignalQuality(outcomes, -1), /threshold must be between 0 and 100/);
  assert.throws(() => compareSignalQuality(outcomes, 101), /threshold must be between 0 and 100/);
  assert.throws(() => splitSignalOutcomes(outcomes, Number.NaN), /finite epoch timestamp/);
});
