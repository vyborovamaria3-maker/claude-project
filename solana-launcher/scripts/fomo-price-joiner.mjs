#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ALLOWED_ARGS = new Set([
  "input", "output", "evidence-output", "audit-output", "base-url",
  "cutoff-at", "horizon-hours", "timeframe",
]);
const ACCEPTED_SOURCES = new Set(["bitquery"]);
const COVERAGE_STATES = new Set(["complete", "partial", "unknown"]);
const BASE58_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HORIZON_TOLERANCE_MS = 5 * 60_000;
const ENTRY_TOLERANCE_MS = 5 * 60_000;

function timestampMs(value, field, nullable = false) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new TypeError("invalid_" + field);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError("invalid_" + field);
  return parsed;
}

function iso(value) {
  return value == null ? null : new Date(value).toISOString();
}

function finiteNumber(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("invalid_" + field);
  }
  return value;
}

function stableStringify(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const record = value;
  return "{" + Object.keys(record).sort().map((key) =>
    JSON.stringify(key) + ":" + stableStringify(record[key]),
  ).join(",") + "}";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function parseArgs(argv, now = Date.now()) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (typeof item !== "string" || !item.startsWith("--")) {
      throw new TypeError("invalid_arguments");
    }
    const equals = item.indexOf("=");
    const key = equals >= 0 ? item.slice(2, equals) : item.slice(2);
    const value = equals >= 0 ? item.slice(equals + 1) : argv[++index];
    if (!ALLOWED_ARGS.has(key) || typeof value !== "string" || !value || Object.hasOwn(parsed, key)) {
      throw new TypeError("invalid_arguments");
    }
    parsed[key] = value;
  }

  for (const key of ["input", "output", "evidence-output", "audit-output"]) {
    if (typeof parsed[key] !== "string") throw new TypeError("missing_" + key.replaceAll("-", "_"));
  }

  const paths = ["input", "output", "evidence-output", "audit-output"].map((key) => resolve(parsed[key]));
  if (new Set(paths).size !== paths.length) throw new TypeError("output_paths_must_be_distinct");

  const baseUrlValue = parsed["base-url"] ?? process.env.FOMO_PRICE_BASE_URL ?? "http://127.0.0.1:3000";
  let baseUrl;
  try {
    baseUrl = new URL(baseUrlValue);
  } catch {
    throw new TypeError("invalid_base_url");
  }
  if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
    throw new TypeError("invalid_base_url");
  }

  let cutoffAtMs = null;
  if (parsed["cutoff-at"] !== undefined) {
    cutoffAtMs = timestampMs(parsed["cutoff-at"], "cutoff_at");
    if (cutoffAtMs > now) throw new TypeError("cutoff_must_not_be_in_future");
  }

  const horizonHours = Number(parsed["horizon-hours"] ?? "24");
  if (!Number.isSafeInteger(horizonHours) || horizonHours < 1 || horizonHours > 720) {
    throw new TypeError("invalid_horizon_hours");
  }
  const timeframe = parsed.timeframe ?? "5m";
  const intervalSeconds = timeframe === "1m" ? 60 : timeframe === "5m" ? 300 : null;
  if (intervalSeconds === null) throw new TypeError("invalid_timeframe");

  return {
    input: resolve(parsed.input),
    output: resolve(parsed.output),
    evidenceOutput: resolve(parsed["evidence-output"]),
    auditOutput: resolve(parsed["audit-output"]),
    baseUrl: baseUrl.origin,
    cutoffAtMs,
    horizonHours,
    timeframe,
    intervalSeconds,
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

export function validateSnapshotRow(raw, index = 0) {
  const prefix = "row_" + (index + 1);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("invalid_" + prefix);
  if (typeof raw.mint !== "string" || !BASE58_MINT.test(raw.mint)) {
    throw new TypeError("invalid_" + prefix + "_mint");
  }
  if (raw.canonicalTokenId !== "solana:" + raw.mint) {
    throw new TypeError("invalid_" + prefix + "_canonical_token_id");
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

  for (const key of ["x", "tg"]) {
    if (!COVERAGE_STATES.has(raw.signalCoverage?.[key])) {
      throw new TypeError("invalid_" + prefix + "_" + key + "_coverage");
    }
  }

  return {
    raw,
    mint: raw.mint,
    canonicalTokenId: raw.canonicalTokenId,
    signalAtMs,
    signalAt: iso(signalAtMs),
    maxInputObservedAtMs,
    signalCoverageKnownAtMs,
  };
}

export function normalizeCandles(rawCandles, intervalSeconds, fetchedAtMs) {
  if (!Array.isArray(rawCandles)) throw new TypeError("invalid_price_candles");
  const byTime = new Map();
  for (const raw of rawCandles) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new TypeError("invalid_price_candle");
    }
    if (!Number.isSafeInteger(raw.time) || raw.time <= 0 || raw.time * 1000 > fetchedAtMs) {
      throw new TypeError("invalid_price_candle_time");
    }
    const candle = {
      time: raw.time,
      open: finiteNumber(raw.open, "candle_open"),
      high: finiteNumber(raw.high, "candle_high"),
      low: finiteNumber(raw.low, "candle_low"),
      close: finiteNumber(raw.close, "candle_close"),
      volume: finiteNumber(raw.volume, "candle_volume"),
    };
    if (
      candle.open <= 0 || candle.high <= 0 || candle.low <= 0 || candle.close <= 0 || candle.volume < 0
      || candle.high < Math.max(candle.open, candle.close, candle.low)
      || candle.low > Math.min(candle.open, candle.close, candle.high)
    ) {
      throw new TypeError("invalid_price_candle_ohlcv");
    }
    const existing = byTime.get(candle.time);
    if (existing) {
      const comparable = {
        time: existing.time,
        open: existing.open,
        high: existing.high,
        low: existing.low,
        close: existing.close,
        volume: existing.volume,
      };
      if (stableStringify(comparable) !== stableStringify(candle)) {
        throw new TypeError("conflicting_duplicate_price_candle");
      }
      continue;
    }
    byTime.set(candle.time, {
      ...candle,
      completeAtFetch: (candle.time + intervalSeconds) * 1000 <= fetchedAtMs,
    });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

export function calculateOutcomeLabel(raw, history, options) {
  const snapshot = validateSnapshotRow(raw);
  const { horizonHours, cutoffAtMs } = options;
  if (snapshot.raw.signalCoverage.x === "unknown" || snapshot.raw.signalCoverage.tg === "unknown") {
    return { status: "excluded", reason: "unknown_signal_source_coverage" };
  }
  const expectedOutcomeAtMs = snapshot.signalAtMs + horizonHours * 60 * 60 * 1000;
  if (expectedOutcomeAtMs > cutoffAtMs) {
    return { status: "excluded", reason: "backtest_incomplete_horizon" };
  }
  if (!history) return { status: "excluded", reason: "price_source_unavailable" };
  if (history.mock) return { status: "excluded", reason: "mock_price_source_rejected" };
  if (!ACCEPTED_SOURCES.has(history.source)) {
    return { status: "excluded", reason: "unsupported_price_source" };
  }
  if (!history.evidenceRef) return { status: "excluded", reason: "price_evidence_missing" };
  if (history.fetchedAtMs > cutoffAtMs) {
    return { status: "excluded", reason: "price_outcome_not_known_by_cutoff" };
  }

  const availableUntilMs = Math.min(cutoffAtMs, history.fetchedAtMs);
  const candles = history.candles.filter((candle) =>
    candle.completeAtFetch && (candle.time + history.intervalSeconds) * 1000 <= availableUntilMs,
  );
  const entryIndex = candles.findIndex((candle) => {
    const startAt = candle.time * 1000;
    return startAt >= snapshot.signalAtMs && startAt <= snapshot.signalAtMs + ENTRY_TOLERANCE_MS;
  });
  if (entryIndex < 0) return { status: "excluded", reason: "entry_price_not_found" };

  const expectedOutcomeAt = expectedOutcomeAtMs;
  const candidates = candles
    .map((candle, index) => ({
      index,
      outcomeAtMs: (candle.time + history.intervalSeconds) * 1000,
    }))
    .filter(({ index, outcomeAtMs }) =>
      index > entryIndex
      && outcomeAtMs > snapshot.signalAtMs
      && outcomeAtMs <= availableUntilMs
      && Math.abs(outcomeAtMs - expectedOutcomeAt) <= HORIZON_TOLERANCE_MS,
    )
    .sort((a, b) =>
      Math.abs(a.outcomeAtMs - expectedOutcomeAt) - Math.abs(b.outcomeAtMs - expectedOutcomeAt)
      || a.outcomeAtMs - b.outcomeAtMs,
    );
  const target = candidates[0];
  if (!target) return { status: "excluded", reason: "fixed_horizon_price_not_found" };

  for (let index = entryIndex + 1; index <= target.index; index += 1) {
    if (candles[index].time - candles[index - 1].time !== history.intervalSeconds) {
      return { status: "excluded", reason: "price_gap_detected" };
    }
  }

  const entryPrice = candles[entryIndex].open;
  const exitPrice = candles[target.index].close;
  if (!(entryPrice > 0) || !(exitPrice > 0)) {
    return { status: "excluded", reason: "invalid_entry_or_exit_price" };
  }

  // Conservative OHLC drawdown: assume each candle's high happened before its low.
  let runningPeak = entryPrice;
  let maxDrawdownPct = 0;
  for (let index = entryIndex; index <= target.index; index += 1) {
    const candle = candles[index];
    runningPeak = Math.max(runningPeak, candle.high);
    maxDrawdownPct = Math.min(maxDrawdownPct, (candle.low / runningPeak - 1) * 100);
  }

  const outcomeAtMs = target.outcomeAtMs;
  const outcomeObservedAtMs = history.fetchedAtMs;
  if (outcomeAtMs > outcomeObservedAtMs || outcomeObservedAtMs > cutoffAtMs) {
    return { status: "excluded", reason: "price_outcome_not_known_by_cutoff" };
  }

  const labelledRow = {
    ...raw,
    outcomeAt: iso(outcomeAtMs),
    outcomeObservedAt: iso(outcomeObservedAtMs),
    outcomeEvidenceRef: history.evidenceRef,
    forwardReturnPct: Number(((exitPrice / entryPrice - 1) * 100).toFixed(8)),
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(8)),
    outcomeCoverage: {
      price: "complete",
      knownAt: iso(outcomeObservedAtMs),
    },
    outcomeMethod: {
      entry: "first complete candle open at or after signal; max delay 5 minutes",
      exit: "nearest complete candle close to signal plus horizon; max offset 5 minutes",
      drawdown: "worst-case OHLC peak-to-trough using candle high before low",
      timeframe: history.timeframe,
      source: history.source,
    },
  };
  return {
    status: "labelled",
    row: labelledRow,
    outcomeAt: labelledRow.outcomeAt,
    evidenceRef: history.evidenceRef,
  };
}

export function buildPriceHistoryUrl(baseUrl, mint, timeframe) {
  const url = new URL("/api/token-history", baseUrl);
  url.searchParams.set("mint", mint);
  url.searchParams.set("tf", timeframe);
  url.searchParams.set("deep", "1");
  url.searchParams.set("source", "bitquery");
  return url;
}

async function fetchPriceHistory(baseUrl, mint, timeframe, intervalSeconds) {
  const url = buildPriceHistoryUrl(baseUrl, mint, timeframe);

  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error("price_source_unavailable");
  const payload = await response.json();
  const fetchedAtMs = Date.now();
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.candles)) {
    throw new Error("invalid_price_response");
  }

  const source = typeof payload.source === "string" ? payload.source : "unknown";
  const candles = normalizeCandles(payload.candles, intervalSeconds, fetchedAtMs);
  const evidenceBase = {
    recordType: "price_evidence",
    schemaVersion: 1,
    canonicalTokenId: "solana:" + mint,
    mint,
    source,
    poolAddress: typeof payload.poolAddress === "string" ? payload.poolAddress : null,
    mock: payload.mock === true || source === "mock",
    requestUrl: url.toString(),
    fetchedAt: iso(fetchedAtMs),
    timeframe,
    intervalSeconds,
    candleCount: candles.length,
    candles,
  };
  const evidenceSha256 = sha256(stableStringify(evidenceBase));
  return {
    ...evidenceBase,
    fetchedAtMs,
    evidenceSha256,
    evidenceRef: "fomo-price-evidence:sha256:" + evidenceSha256,
    evidenceRecord: { ...evidenceBase, evidenceSha256 },
  };
}

function safeFailureCode(error) {
  if (error instanceof Error && /^[a-z0-9_]{1,64}$/.test(error.message)) return error.message;
  return "price_source_unavailable";
}

function jsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");
}

async function writeAtomic(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = path + "." + process.pid + ".tmp";
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, path);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputContent = await readFile(args.input, "utf8");
  const snapshots = parseJsonl(inputContent);
  const validated = snapshots.map((row, index) => validateSnapshotRow(row, index));
  const uniqueMints = [...new Set(validated.map((row) => row.mint))];
  const histories = new Map();
  const failures = new Map();

  for (const mint of uniqueMints) {
    try {
      histories.set(mint, await fetchPriceHistory(args.baseUrl, mint, args.timeframe, args.intervalSeconds));
    } catch (error) {
      failures.set(mint, safeFailureCode(error));
    }
  }

  const cutoffAtMs = args.cutoffAtMs ?? Date.now();
  const labelledRows = [];
  const auditRows = [];
  const exclusionCounts = {};
  for (let index = 0; index < snapshots.length; index += 1) {
    const raw = snapshots[index];
    const snapshot = validated[index];
    const history = histories.get(snapshot.mint);
    let result;
    if (failures.has(snapshot.mint)) {
      result = { status: "excluded", reason: failures.get(snapshot.mint) };
    } else {
      result = calculateOutcomeLabel(raw, history, {
        horizonHours: args.horizonHours,
        cutoffAtMs,
      });
    }

    if (result.status === "labelled") {
      labelledRows.push(result.row);
    } else {
      exclusionCounts[result.reason] = (exclusionCounts[result.reason] ?? 0) + 1;
    }
    auditRows.push({
      snapshotId: typeof raw.snapshotId === "string" ? raw.snapshotId : null,
      canonicalTokenId: snapshot.canonicalTokenId,
      signalAt: snapshot.signalAt,
      status: result.status,
      reason: result.reason ?? null,
      outcomeAt: result.outcomeAt ?? null,
      evidenceRef: result.evidenceRef ?? null,
    });
  }

  const evidenceRows = [...histories.values()].map((history) => history.evidenceRecord);
  const outputContent = jsonl(labelledRows);
  const evidenceContent = jsonl(evidenceRows);
  const report = {
    schemaVersion: 1,
    generatedAt: iso(Date.now()),
    cutoffAt: iso(cutoffAtMs),
    horizonHours: args.horizonHours,
    timeframe: args.timeframe,
    intervalSeconds: args.intervalSeconds,
    inputRows: snapshots.length,
    uniqueTokensRequested: uniqueMints.length,
    priceHistoriesFetched: histories.size,
    priceHistoryFailures: failures.size,
    labelledRows: labelledRows.length,
    excludedRows: auditRows.length - labelledRows.length,
    exclusionCounts,
    labelledOutputSha256: sha256(outputContent),
    evidenceOutputSha256: sha256(evidenceContent),
    coveragePolicy: "complete only for supported non-mock sources with a contiguous candle sequence from entry through fixed-horizon exit; no interpolation or zero-return imputation",
    drawdownPolicy: "conservative worst-case OHLC peak-to-trough, assuming high precedes low within each candle",
    rows: auditRows,
  };

  await writeAtomic(args.output, outputContent);
  await writeAtomic(args.evidenceOutput, evidenceContent);
  await writeAtomic(args.auditOutput, JSON.stringify(report, null, 2) + "\n");
  process.stderr.write(JSON.stringify({
    cutoffAt: report.cutoffAt,
    inputRows: report.inputRows,
    labelledRows: report.labelledRows,
    excludedRows: report.excludedRows,
    exclusionCounts: report.exclusionCounts,
  }) + "\n");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    const code = error instanceof Error && /^[a-z0-9_]{1,64}$/.test(error.message)
      ? error.message
      : "fomo_price_join_failed";
    process.stderr.write(code + "\n");
    process.exitCode = 1;
  });
}
