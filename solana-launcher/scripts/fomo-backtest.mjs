#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ALLOWED_ARGS = new Set([
  "input", "output", "from", "to", "cutoff-at", "horizon-hours",
  "pressure-threshold", "quality-threshold", "min-quality-coverage",
  "target-return-pct", "adverse-drawdown-pct",
]);
const COVERAGE_STATES = new Set(["complete", "partial", "unknown"]);
const HORIZON_TOLERANCE_MS = 5 * 60 * 1000;

function isUtcDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function timestampMs(value, field, nullable = false) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new TypeError("invalid_" + field);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError("invalid_" + field);
  return parsed;
}

function finiteNumber(value, field, nullable = false) {
  if ((value === null || value === undefined) && nullable) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("invalid_" + field);
  }
  return value;
}

function coverageState(value, field) {
  if (!COVERAGE_STATES.has(value)) throw new TypeError("invalid_" + field);
  return value;
}

export function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    if (typeof argument !== "string" || !argument.startsWith("--")) {
      throw new TypeError("invalid_arguments");
    }
    const equals = argument.indexOf("=");
    const key = equals >= 0 ? argument.slice(2, equals) : argument.slice(2);
    const value = equals >= 0 ? argument.slice(equals + 1) : argv[++i];
    if (!ALLOWED_ARGS.has(key)) throw new TypeError("unknown_argument");
    if (Object.hasOwn(parsed, key) || typeof value !== "string" || value.length === 0) {
      throw new TypeError("invalid_arguments");
    }
    parsed[key] = value;
  }

  for (const key of ["input", "from", "to", "cutoff-at"]) {
    if (typeof parsed[key] !== "string") throw new TypeError("missing_" + key.replaceAll("-", "_"));
  }
  if (!isUtcDate(parsed.from) || !isUtcDate(parsed.to) || parsed.from > parsed.to) {
    throw new TypeError("invalid_date_range");
  }
  const cutoffAtMs = timestampMs(parsed["cutoff-at"], "cutoff_at");
  if (cutoffAtMs > Date.now()) throw new TypeError("cutoff_must_not_be_in_future");

  const horizonHours = Number(parsed["horizon-hours"] ?? "24");
  if (!Number.isSafeInteger(horizonHours) || horizonHours < 1 || horizonHours > 720) {
    throw new TypeError("invalid_horizon_hours");
  }
  const pressureThreshold = Number(parsed["pressure-threshold"] ?? "70");
  const qualityThreshold = Number(parsed["quality-threshold"] ?? "60");
  const minQualityCoverage = Number(parsed["min-quality-coverage"] ?? "0.75");
  const targetReturnPct = Number(parsed["target-return-pct"] ?? "10");
  const adverseDrawdownPct = Number(parsed["adverse-drawdown-pct"] ?? "-20");
  if (!Number.isFinite(pressureThreshold) || pressureThreshold < 0 || pressureThreshold > 100) {
    throw new TypeError("invalid_pressure_threshold");
  }
  if (!Number.isFinite(qualityThreshold) || qualityThreshold < 0 || qualityThreshold > 100) {
    throw new TypeError("invalid_quality_threshold");
  }
  if (!Number.isFinite(minQualityCoverage) || minQualityCoverage < 0 || minQualityCoverage > 1) {
    throw new TypeError("invalid_quality_coverage");
  }
  if (!Number.isFinite(targetReturnPct) || targetReturnPct < -100) {
    throw new TypeError("invalid_target_return");
  }
  if (!Number.isFinite(adverseDrawdownPct) || adverseDrawdownPct > 0 || adverseDrawdownPct < -100) {
    throw new TypeError("invalid_adverse_drawdown");
  }

  return {
    input: parsed.input,
    output: parsed.output ?? null,
    from: parsed.from,
    to: parsed.to,
    cutoffAt: new Date(cutoffAtMs).toISOString(),
    horizonHours,
    pressureThreshold,
    qualityThreshold,
    minQualityCoverage,
    targetReturnPct,
    adverseDrawdownPct,
  };
}

export function parseJsonl(content) {
  if (typeof content !== "string") throw new TypeError("invalid_input_content");
  const rows = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      throw new TypeError("invalid_jsonl_line_" + (index + 1));
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("invalid_jsonl_row_" + (index + 1));
    }
    rows.push(value);
  }
  if (!rows.length) throw new TypeError("empty_input_dataset");
  return rows;
}

function normalizeObservation(raw, index) {
  const prefix = "row_" + (index + 1);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("invalid_" + prefix);
  }
  if (typeof raw.canonicalTokenId !== "string" || !raw.canonicalTokenId.trim()) {
    throw new TypeError("invalid_" + prefix + "_token_id");
  }
  if (typeof raw.scoreVersion !== "string" || !raw.scoreVersion.trim()) {
    throw new TypeError("invalid_" + prefix + "_score_version");
  }

  const signalAtMs = timestampMs(raw.signalAt, prefix + "_signal_at");
  const maxInputObservedAtMs = timestampMs(raw.maxInputObservedAt, prefix + "_max_input_observed_at");
  const signalCoverageKnownAtMs = timestampMs(raw.signalCoverage?.knownAt, prefix + "_signal_coverage_known_at");
  if (maxInputObservedAtMs > signalAtMs || signalCoverageKnownAtMs > signalAtMs) {
    throw new TypeError("lookahead_input_observed_after_signal");
  }

  const fomoPressure = finiteNumber(raw.fomoPressure, prefix + "_fomo_pressure");
  const fomoQuality = finiteNumber(raw.fomoQuality, prefix + "_fomo_quality");
  const qualityCoverage = finiteNumber(raw.qualityCoverage, prefix + "_quality_coverage");
  if (fomoPressure < 0 || fomoPressure > 100 || fomoQuality < 0 || fomoQuality > 100) {
    throw new TypeError("score_out_of_range");
  }
  if (qualityCoverage < 0 || qualityCoverage > 1) throw new TypeError("quality_coverage_out_of_range");

  const signalCoverage = {
    x: coverageState(raw.signalCoverage?.x, prefix + "_x_coverage"),
    tg: coverageState(raw.signalCoverage?.tg, prefix + "_tg_coverage"),
    knownAtMs: signalCoverageKnownAtMs,
  };
  const outcomeCoverageKnownAtMs = timestampMs(
    raw.outcomeCoverage?.knownAt,
    prefix + "_outcome_coverage_known_at",
    true,
  );
  const outcomeCoverage = {
    price: raw.outcomeCoverage?.price == null
      ? "unknown"
      : coverageState(raw.outcomeCoverage.price, prefix + "_price_coverage"),
    knownAtMs: outcomeCoverageKnownAtMs,
  };

  const outcomeAtMs = timestampMs(raw.outcomeAt, prefix + "_outcome_at", true);
  const outcomeObservedAtMs = timestampMs(raw.outcomeObservedAt, prefix + "_outcome_observed_at", true);
  const forwardReturnPct = finiteNumber(raw.forwardReturnPct, prefix + "_forward_return_pct", true);
  const maxDrawdownPct = finiteNumber(raw.maxDrawdownPct, prefix + "_max_drawdown_pct", true);
  const outcomeEvidenceRef = typeof raw.outcomeEvidenceRef === "string" && raw.outcomeEvidenceRef.trim()
    ? raw.outcomeEvidenceRef.trim()
    : null;

  return {
    canonicalTokenId: raw.canonicalTokenId.trim(),
    signalAtMs,
    signalAt: new Date(signalAtMs).toISOString(),
    signalDay: new Date(signalAtMs).toISOString().slice(0, 10),
    maxInputObservedAtMs,
    signalCoverage,
    fomoPressure,
    fomoQuality,
    qualityCoverage,
    scoreVersion: raw.scoreVersion,
    outcomeAtMs,
    outcomeObservedAtMs,
    outcomeCoverage,
    forwardReturnPct,
    maxDrawdownPct,
    outcomeEvidenceRef,
  };
}

function selectLatestTokenDays(rows, from, to) {
  const inRange = rows.filter((row) => row.signalDay >= from && row.signalDay <= to);
  const latest = new Map();
  for (const row of inRange) {
    const key = row.canonicalTokenId + "|" + row.signalDay;
    const prior = latest.get(key);
    if (prior && prior.signalAtMs === row.signalAtMs) {
      throw new TypeError("duplicate_token_day_signal_timestamp");
    }
    if (!prior || row.signalAtMs > prior.signalAtMs) latest.set(key, row);
  }
  return {
    inRangeCount: inRange.length,
    selected: [...latest.values()].sort((a, b) =>
      a.signalAtMs - b.signalAtMs || a.canonicalTokenId.localeCompare(b.canonicalTokenId)),
  };
}

function validateSelectedOutcome(row, options, cutoffAtMs) {
  if (row.signalCoverage.x === "unknown" || row.signalCoverage.tg === "unknown") {
    throw new TypeError("unknown_signal_source_coverage");
  }
  const expectedOutcomeAt = row.signalAtMs + options.horizonHours * 60 * 60 * 1000;
  if (row.signalAtMs + options.horizonHours * 60 * 60 * 1000 > cutoffAtMs) {
    throw new TypeError("backtest_incomplete_horizon");
  }
  if (
    row.outcomeAtMs === null ||
    row.outcomeObservedAtMs === null ||
    row.forwardReturnPct === null ||
    row.maxDrawdownPct === null ||
    !row.outcomeEvidenceRef
  ) {
    throw new TypeError("incomplete_outcome_label");
  }
  if (row.outcomeCoverage.price !== "complete" || row.outcomeCoverage.knownAtMs === null) {
    throw new TypeError("incomplete_price_outcome_coverage");
  }
  if (Math.abs(row.outcomeAtMs - expectedOutcomeAt) > HORIZON_TOLERANCE_MS) {
    throw new TypeError("outcome_outside_fixed_horizon");
  }
  if (row.outcomeAtMs <= row.signalAtMs || row.outcomeObservedAtMs < row.outcomeAtMs) {
    throw new TypeError("invalid_outcome_timing");
  }
  if (
    row.outcomeObservedAtMs > cutoffAtMs ||
    row.outcomeCoverage.knownAtMs < row.outcomeAtMs ||
    row.outcomeCoverage.knownAtMs > cutoffAtMs
  ) {
    throw new TypeError("outcome_not_known_by_cutoff");
  }
  if (row.forwardReturnPct < -100 || row.maxDrawdownPct < -100 || row.maxDrawdownPct > 0) {
    throw new TypeError("invalid_return_or_drawdown");
  }
}

function round(value) {
  return value === null || !Number.isFinite(value) ? null : Math.round(value * 10000) / 10000;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function averageRanks(values) {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = new Array(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i + 1;
    while (j < order.length && order[j].value === order[i].value) j += 1;
    const averageRank = ((i + 1) + j) / 2;
    for (let k = i; k < j; k += 1) ranks[order[k].index] = averageRank;
    i = j;
  }
  return ranks;
}

function pearsonCorrelation(left, right) {
  if (left.length < 2 || left.length !== right.length) return null;
  const leftMean = mean(left);
  const rightMean = mean(right);
  let numerator = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let i = 0; i < left.length; i += 1) {
    const dx = left[i] - leftMean;
    const dy = right[i] - rightMean;
    numerator += dx * dy;
    leftVariance += dx * dx;
    rightVariance += dy * dy;
  }
  const denominator = Math.sqrt(leftVariance * rightVariance);
  return denominator > 0 ? numerator / denominator : null;
}

export function spearmanRankCorrelation(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    throw new TypeError("invalid_correlation_inputs");
  }
  if (left.some((value) => !Number.isFinite(value)) || right.some((value) => !Number.isFinite(value))) {
    throw new TypeError("invalid_correlation_values");
  }
  return round(pearsonCorrelation(averageRanks(left), averageRanks(right)));
}

function summarizeCohort(rows, options) {
  const returns = rows.map((row) => row.forwardReturnPct);
  const drawdowns = rows.map((row) => row.maxDrawdownPct);
  return {
    count: rows.length,
    uniqueTokens: new Set(rows.map((row) => row.canonicalTokenId)).size,
    meanForwardReturnPct: round(mean(returns)),
    medianForwardReturnPct: round(median(returns)),
    positiveReturnRatePct: round(mean(returns.map((value) => value > 0 ? 100 : 0))),
    targetReturnHitRatePct: round(mean(returns.map((value) => value >= options.targetReturnPct ? 100 : 0))),
    meanMaxDrawdownPct: round(mean(drawdowns)),
    adverseDrawdownRatePct: round(mean(drawdowns.map((value) =>
      value <= options.adverseDrawdownPct ? 100 : 0))),
    meanFomoPressure: round(mean(rows.map((row) => row.fomoPressure))),
    meanFomoQuality: round(mean(rows.map((row) => row.fomoQuality))),
  };
}

export function evaluateFomoDataset(rawRows, options, datasetSha256 = null) {
  if (!Array.isArray(rawRows) || !rawRows.length) throw new TypeError("empty_input_dataset");
  if (!isUtcDate(options.from) || !isUtcDate(options.to) || options.from > options.to) {
    throw new TypeError("invalid_date_range");
  }
  const cutoffAtMs = timestampMs(options.cutoffAt, "cutoff_at");
  if (cutoffAtMs > Date.now()) throw new TypeError("cutoff_must_not_be_in_future");
  if (!Number.isSafeInteger(options.horizonHours) || options.horizonHours < 1 || options.horizonHours > 720) {
    throw new TypeError("invalid_horizon_hours");
  }

  const normalized = rawRows.map(normalizeObservation);
  const { inRangeCount, selected } = selectLatestTokenDays(normalized, options.from, options.to);
  if (!selected.length) throw new TypeError("no_in_range_observations");
  for (const row of selected) validateSelectedOutcome(row, options, cutoffAtMs);

  const versions = [...new Set(selected.map((row) => row.scoreVersion))];
  if (versions.length !== 1) throw new TypeError("mixed_score_versions");
  const pressureHigh = selected.filter((row) => row.fomoPressure >= options.pressureThreshold);
  const qualityHigh = selected.filter((row) =>
    row.fomoQuality >= options.qualityThreshold && row.qualityCoverage >= options.minQualityCoverage);
  const qualityHighKeys = new Set(qualityHigh.map((row) => row.canonicalTokenId + "|" + row.signalDay));
  const pressureHighQualityHigh = pressureHigh.filter((row) =>
    qualityHighKeys.has(row.canonicalTokenId + "|" + row.signalDay));
  const pressureHighQualityLow = pressureHigh.filter((row) =>
    !qualityHighKeys.has(row.canonicalTokenId + "|" + row.signalDay));

  return {
    schemaVersion: "fomo-backtest-v1",
    datasetSha256,
    signalRangeUtc: { from: options.from, to: options.to },
    dataCutoffAt: new Date(cutoffAtMs).toISOString(),
    horizonHours: options.horizonHours,
    scoreVersion: versions[0],
    thresholds: {
      pressureHighAt: options.pressureThreshold,
      qualityHighAt: options.qualityThreshold,
      minimumQualityCoverage: options.minQualityCoverage,
      targetReturnPct: options.targetReturnPct,
      adverseDrawdownAtOrBelowPct: options.adverseDrawdownPct,
    },
    sample: {
      inputRows: rawRows.length,
      inRangeRows: inRangeCount,
      selectedTokenDays: selected.length,
      duplicateSnapshotsRemoved: inRangeCount - selected.length,
      uniqueTokens: new Set(selected.map((row) => row.canonicalTokenId)).size,
      sourceCoverage: "unknown X/TG coverage is rejected; partial coverage is accepted and explicitly counted; no population-completeness claim",
      completeSourceCoverageTokenDays: selected.filter((row) => row.signalCoverage.x === "complete" && row.signalCoverage.tg === "complete").length,
      partialSourceCoverageTokenDays: selected.filter((row) => row.signalCoverage.x === "partial" || row.signalCoverage.tg === "partial").length,
    },
    metrics: {
      allEligible: summarizeCohort(selected, options),
      pressureHigh: summarizeCohort(pressureHigh, options),
      qualityHigh: summarizeCohort(qualityHigh, options),
      pressureHighQualityHigh: summarizeCohort(pressureHighQualityHigh, options),
      pressureHighQualityLow: summarizeCohort(pressureHighQualityLow, options),
      spearmanPressureVsForwardReturn: spearmanRankCorrelation(
        selected.map((row) => row.fomoPressure),
        selected.map((row) => row.forwardReturnPct),
      ),
      spearmanQualityVsForwardReturn: spearmanRankCorrelation(
        selected.map((row) => row.fomoQuality),
        selected.map((row) => row.forwardReturnPct),
      ),
    },
    limitations: [
      "Descriptive historical association only; not a causal estimate or a profitability guarantee.",
      "Repeated observations for the same token can be dependent; no naive p-values or independent-sample confidence intervals are reported.",
      "FOMO scores must be recorded point-in-time. Do not pair today's scores with past price returns.",
      "Partial X/Telegram coverage means results describe the captured sample, not the full platform population; sample selection can bias outcomes.",
      "Score and source-coverage versions must match the recorded snapshot; X/Telegram inputs known after signal time are rejected.",
      "Forward return is measured at the fixed horizon (outcome timestamp tolerance: 5 minutes); max drawdown is a signed percentage at or below zero.",
    ],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let inputText;
  try {
    inputText = await readFile(resolve(args.input), "utf8");
  } catch {
    throw new Error("input_read_failed");
  }
  const rows = parseJsonl(inputText);
  const digest = createHash("sha256").update(inputText).digest("hex");
  const report = evaluateFomoDataset(rows, args, digest);
  const serialized = JSON.stringify(report, null, 2) + "\n";
  if (args.output) {
    try {
      await writeFile(resolve(args.output), serialized, "utf8");
    } catch {
      throw new Error("report_write_failed");
    }
  }
  process.stdout.write(serialized);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    const code = error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
      ? error.message
      : "fomo_backtest_failed";
    process.stderr.write(code + "\n");
    process.exitCode = 1;
  });
}
