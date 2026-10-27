import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateFomoDataset,
  parseArgs,
  parseJsonl,
  spearmanRankCorrelation,
} from "./fomo-backtest.mjs";

const CUTOFF = "2025-01-05T00:00:00.000Z";

function row({
  token = "token-a",
  signalAt = "2025-01-01T00:00:00.000Z",
  pressure = 80,
  quality = 80,
  qualityCoverage = 1,
  forwardReturn = 15,
  drawdown = -10,
  outcome = true,
  xCoverage = "complete",
  tgCoverage = "complete",
  signalCoverageKnownAt = signalAt,
  maxInputObservedAt = signalAt,
  scoreVersion = "fomo-v1",
} = {}) {
  const signalMs = Date.parse(signalAt);
  const outcomeAt = new Date(signalMs + 24 * 60 * 60 * 1000).toISOString();
  return {
    canonicalTokenId: token,
    signalAt,
    maxInputObservedAt,
    scoreVersion,
    fomoPressure: pressure,
    fomoQuality: quality,
    qualityCoverage,
    signalCoverage: {
      x: xCoverage,
      tg: tgCoverage,
      knownAt: signalCoverageKnownAt,
    },
    outcomeAt: outcome ? outcomeAt : null,
    outcomeObservedAt: outcome ? new Date(Date.parse(outcomeAt) + 60_000).toISOString() : null,
    outcomeCoverage: outcome ? {
      price: "complete",
      knownAt: new Date(Date.parse(outcomeAt) + 60_000).toISOString(),
    } : null,
    forwardReturnPct: outcome ? forwardReturn : null,
    maxDrawdownPct: outcome ? drawdown : null,
    outcomeEvidenceRef: outcome ? "fixture:price-candles:" + token : null,
  };
}

function options(overrides = {}) {
  return {
    from: "2025-01-01",
    to: "2025-01-01",
    cutoffAt: CUTOFF,
    horizonHours: 24,
    pressureThreshold: 70,
    qualityThreshold: 60,
    minQualityCoverage: 0.75,
    targetReturnPct: 10,
    adverseDrawdownPct: -20,
    ...overrides,
  };
}

test("compares high-pressure tokens with high- and low-quality cohorts", () => {
  const dataset = [
    row({ token: "a", pressure: 90, quality: 90, forwardReturn: 20, drawdown: -10, xCoverage: "partial", tgCoverage: "partial" }),
    row({ token: "b", pressure: 85, quality: 30, forwardReturn: -30, drawdown: -40 }),
    row({ token: "c", pressure: 40, quality: 80, forwardReturn: 10, drawdown: -5 }),
    row({ token: "d", pressure: 45, quality: 40, qualityCoverage: 0.4, forwardReturn: -5, drawdown: -12 }),
  ];
  const report = evaluateFomoDataset(dataset, options(), "test-hash");

  assert.equal(report.sample.selectedTokenDays, 4);
  assert.equal(report.sample.partialSourceCoverageTokenDays, 1);
  assert.equal(report.metrics.pressureHigh.count, 2);
  assert.equal(report.metrics.qualityHigh.count, 2);
  assert.equal(report.metrics.pressureHighQualityHigh.count, 1);
  assert.equal(report.metrics.pressureHighQualityLow.count, 1);
  assert.equal(report.metrics.pressureHighQualityHigh.meanForwardReturnPct, 20);
  assert.equal(report.metrics.pressureHighQualityLow.meanForwardReturnPct, -30);
  assert.equal(report.datasetSha256, "test-hash");
});

test("keeps only the latest available snapshot per token and UTC day", () => {
  const earlier = row({
    token: "same-token",
    signalAt: "2025-01-01T00:00:00.000Z",
    pressure: 20,
    quality: 20,
    forwardReturn: -15,
  });
  const later = row({
    token: "same-token",
    signalAt: "2025-01-01T12:00:00.000Z",
    pressure: 90,
    quality: 85,
    forwardReturn: 25,
  });
  const report = evaluateFomoDataset([earlier, later], options(), null);

  assert.equal(report.sample.inRangeRows, 2);
  assert.equal(report.sample.selectedTokenDays, 1);
  assert.equal(report.sample.duplicateSnapshotsRemoved, 1);
  assert.equal(report.metrics.allEligible.meanForwardReturnPct, 25);
});

test("rejects signal features or coverage that became available after the signal", () => {
  const lateInput = row({
    maxInputObservedAt: "2025-01-01T00:00:01.000Z",
  });
  assert.throws(
    () => evaluateFomoDataset([lateInput], options()),
    /lookahead_input_observed_after_signal/,
  );

  const lateCoverage = row({
    signalCoverageKnownAt: "2025-01-01T00:00:01.000Z",
  });
  assert.throws(
    () => evaluateFomoDataset([lateCoverage], options()),
    /lookahead_input_observed_after_signal/,
  );
});

test("fails closed when the selected token-day lacks a completed outcome", () => {
  const incomplete = row({ token: "missing-outcome", outcome: false });
  assert.throws(
    () => evaluateFomoDataset([incomplete], options()),
    /incomplete_outcome_label/,
  );
});

test("rejects unknown source coverage but accepts explicitly partial samples", () => {
  const unknown = row({ xCoverage: "unknown" });
  assert.throws(
    () => evaluateFomoDataset([unknown], options()),
    /unknown_signal_source_coverage/,
  );
  const partial = row({ xCoverage: "partial", tgCoverage: "partial" });
  const report = evaluateFomoDataset([partial], options());
  assert.equal(report.sample.partialSourceCoverageTokenDays, 1);
});

test("requires the outcome at the requested fixed horizon", () => {
  const malformed = row();
  malformed.outcomeAt = "2025-01-01T12:00:00.000Z";
  assert.throws(
    () => evaluateFomoDataset([malformed], options()),
    /outcome_outside_fixed_horizon/,
  );
});

test("parses JSONL and rejects malformed rows", () => {
  assert.equal(parseJsonl('{"a":1}\n\n{"b":2}\n').length, 2);
  assert.throws(() => parseJsonl('{"a":1}\nnope\n'), /invalid_jsonl_line_2/);
});

test("validates CLI thresholds and date ranges", () => {
  const parsed = parseArgs([
    "--input", "scores.jsonl",
    "--from", "2025-01-01",
    "--to", "2025-01-02",
    "--cutoff-at", CUTOFF,
    "--pressure-threshold", "75",
    "--quality-threshold=65",
  ]);
  assert.equal(parsed.pressureThreshold, 75);
  assert.equal(parsed.qualityThreshold, 65);
  assert.throws(
    () => parseArgs(["--input", "scores.jsonl", "--from", "2025-02-30", "--to", "2025-03-01", "--cutoff-at", CUTOFF]),
    /invalid_date_range/,
  );
});

test("Spearman correlation is rank-based and handles ties", () => {
  assert.equal(spearmanRankCorrelation([1, 2, 3], [10, 20, 30]), 1);
  assert.equal(spearmanRankCorrelation([1, 2, 3], [30, 20, 10]), -1);
  assert.equal(spearmanRankCorrelation([1, 1, 1], [2, 3, 4]), null);
});
