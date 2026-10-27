import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateOutcomeLabel,
  normalizeCandles,
  parseArgs,
  parseJsonl,
  validateSnapshotRow,
} from "./fomo-price-joiner.mjs";

const SIGNAL_MS = Date.parse("2025-01-01T00:00:00.000Z");
const FETCHED_MS = Date.parse("2025-01-03T00:00:00.000Z");
const MINT = "So11111111111111111111111111111111111111112";
const TOKEN = "solana:" + MINT;

function snapshot(overrides = {}) {
  const signalAt = new Date(SIGNAL_MS).toISOString();
  return {
    snapshotId: "snapshot-1",
    canonicalTokenId: TOKEN,
    mint: MINT,
    signalAt,
    maxInputObservedAt: signalAt,
    scoreVersion: "fomo-pressure-quality-v1",
    fomoPressure: 80,
    fomoQuality: 75,
    qualityCoverage: 0.9,
    signalCoverage: { x: "partial", tg: "partial", knownAt: signalAt },
    outcomeAt: null,
    outcomeObservedAt: null,
    outcomeEvidenceRef: null,
    forwardReturnPct: null,
    maxDrawdownPct: null,
    outcomeCoverage: { price: "unknown", knownAt: null },
    ...overrides,
  };
}

function history({ gaps = false, source = "bitquery", mock = false, fetchedAtMs = FETCHED_MS } = {}) {
  const intervalSeconds = 300;
  const candles = [];
  const start = Math.floor(SIGNAL_MS / 1000 / intervalSeconds) * intervalSeconds;
  const end = SIGNAL_MS + 24 * 60 * 60 * 1000;
  for (let time = start; time <= Math.floor(end / 1000 / intervalSeconds) * intervalSeconds; time += intervalSeconds) {
    if (time * 1000 < SIGNAL_MS) continue;
    if (gaps && time === start + intervalSeconds * 12) continue;
    const step = Math.round((time * 1000 - SIGNAL_MS) / 1000 / intervalSeconds);
    const open = 1 + step * 0.001;
    candles.push({
      time,
      open,
      high: open * 1.02,
      low: open * (step === 3 ? 0.8 : 0.98),
      close: open * 1.005,
      volume: 100,
      completeAtFetch: (time + intervalSeconds) * 1000 <= fetchedAtMs,
    });
  }
  return {
    source,
    mock,
    fetchedAtMs,
    intervalSeconds,
    timeframe: "5m",
    candles,
    evidenceRef: "fomo-price-evidence:sha256:" + "a".repeat(64),
  };
}

function options(overrides = {}) {
  return {
    horizonHours: 24,
    cutoffAtMs: FETCHED_MS,
    ...overrides,
  };
}

test("labels a matured snapshot only when source candles are contiguous", () => {
  const result = calculateOutcomeLabel(snapshot(), history(), options());
  assert.equal(result.status, "labelled");
  assert.equal(result.row.outcomeCoverage.price, "complete");
  assert.equal(result.row.outcomeObservedAt, new Date(FETCHED_MS).toISOString());
  assert.match(result.row.outcomeEvidenceRef, /^fomo-price-evidence:sha256:[0-9a-f]{64}$/);
  assert.ok(result.row.outcomeAt);
  assert.ok(Number.isFinite(result.row.forwardReturnPct));
  assert.ok(result.row.maxDrawdownPct <= 0);
  assert.equal(result.row.outcomeMethod.timeframe, "5m");
});

test("rejects gaps rather than interpolating missing prices", () => {
  const result = calculateOutcomeLabel(snapshot(), history({ gaps: true }), options());
  assert.deepEqual(result, { status: "excluded", reason: "price_gap_detected" });
});

test("rejects incomplete horizons even if a price series is present", () => {
  const result = calculateOutcomeLabel(
    snapshot(),
    history(),
    options({ cutoffAtMs: SIGNAL_MS + 12 * 60 * 60 * 1000 }),
  );
  assert.deepEqual(result, { status: "excluded", reason: "backtest_incomplete_horizon" });
});

test("rejects outcomes observed after the configured cutoff", () => {
  const result = calculateOutcomeLabel(
    snapshot(),
    history({ fetchedAtMs: FETCHED_MS }),
    options({ cutoffAtMs: FETCHED_MS - 1 }),
  );
  assert.deepEqual(result, { status: "excluded", reason: "price_outcome_not_known_by_cutoff" });
});

test("rejects mock candles and unsupported sources", () => {
  assert.equal(
    calculateOutcomeLabel(snapshot(), history({ mock: true, source: "mock" }), options()).reason,
    "mock_price_source_rejected",
  );
  assert.equal(
    calculateOutcomeLabel(snapshot(), history({ source: "pumpfun" }), options()).reason,
    "unsupported_price_source",
  );
  assert.equal(
    calculateOutcomeLabel(snapshot(), history({ source: "unknown" }), options()).reason,
    "unsupported_price_source",
  );
  assert.equal(
    calculateOutcomeLabel(snapshot(), history({ source: "geckoterminal" }), options()).reason,
    "unsupported_price_source",
  );
  assert.equal(
    calculateOutcomeLabel(snapshot(), history({ source: "geckoterminal" }), options()).reason,
    "unsupported_price_source",
  );
});

test("rejects unknown X or Telegram coverage", () => {
  const result = calculateOutcomeLabel(
    snapshot({ signalCoverage: { x: "unknown", tg: "partial", knownAt: new Date(SIGNAL_MS).toISOString() } }),
    history(),
    options(),
  );
  assert.deepEqual(result, { status: "excluded", reason: "unknown_signal_source_coverage" });
});

test("rejects snapshots whose input data was observed after the signal", () => {
  const row = snapshot({ maxInputObservedAt: new Date(SIGNAL_MS + 1).toISOString() });
  assert.throws(() => validateSnapshotRow(row), /lookahead_input_observed_after_signal/);
});

test("normalizes candle rows and rejects invalid OHLCV or future candle times", () => {
  const valid = normalizeCandles([
    { time: Math.floor((FETCHED_MS - 600_000) / 1000), open: 1, high: 1.2, low: 0.8, close: 1.1, volume: 20 },
  ], 300, FETCHED_MS);
  assert.equal(valid.length, 1);
  assert.throws(() => normalizeCandles([
    { time: Math.floor((FETCHED_MS - 600_000) / 1000), open: 1, high: 0.9, low: 0.8, close: 1.1, volume: 20 },
  ], 300, FETCHED_MS), /invalid_price_candle_ohlcv/);
  assert.throws(() => normalizeCandles([
    { time: Math.floor(FETCHED_MS / 1000) + 1, open: 1, high: 1.2, low: 0.8, close: 1.1, volume: 20 },
  ], 300, FETCHED_MS), /invalid_price_candle_time/);
});

test("rejects conflicting duplicate candle timestamps", () => {
  const time = Math.floor((FETCHED_MS - 600_000) / 1000);
  assert.throws(() => normalizeCandles([
    { time, open: 1, high: 1.2, low: 0.8, close: 1.1, volume: 20 },
    { time, open: 1, high: 1.3, low: 0.8, close: 1.1, volume: 20 },
  ], 300, FETCHED_MS), /conflicting_duplicate_price_candle/);
});

test("parses JSONL and rejects malformed input", () => {
  assert.equal(parseJsonl('{"a":1}\n\n{"b":2}\n').length, 2);
  assert.throws(() => parseJsonl('{"a":1}\nnot-json\n'), /invalid_jsonl_line_2/);
  assert.throws(() => parseJsonl("\n \n"), /empty_input_dataset/);
});

test("validates required CLI paths, cutoff and timeframe", () => {
  const parsed = parseArgs([
    "--input", "signals.jsonl",
    "--output", "labelled.jsonl",
    "--evidence-output", "price-evidence.jsonl",
    "--audit-output", "audit.json",
    "--timeframe=5m",
  ], FETCHED_MS);
  assert.equal(parsed.timeframe, "5m");
  assert.equal(parsed.horizonHours, 24);
  assert.throws(() => parseArgs([
    "--input", "signals.jsonl",
    "--output", "labelled.jsonl",
    "--evidence-output", "price-evidence.jsonl",
    "--audit-output", "audit.json",
    "--timeframe", "1h",
  ], FETCHED_MS), /invalid_timeframe/);
  assert.throws(() => parseArgs([
    "--input", "same.jsonl",
    "--output", "same.jsonl",
    "--evidence-output", "price-evidence.jsonl",
    "--audit-output", "audit.json",
  ], FETCHED_MS), /output_paths_must_be_distinct/);
});
