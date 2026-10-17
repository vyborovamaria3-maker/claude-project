import { closePool, q, q1 } from "../lib/trade/pg";
import {
  compareSignalQuality,
  splitSignalOutcomes,
  type SignalQualityOutcome,
  type SignalQualityComparison,
} from "../src/intelligence/signals/quality";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const VALID_SOURCES = new Set(["hype", "ultra", "early_signal", "entity"]);

interface OutcomeRow {
  signal_at: string;
  score: string;
  outcome_status: string;
  attention_change_pct: string | null;
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function numericArg(name: string, fallback: number, min: number, max: number): number {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function timestampArg(value: string, name: string): number {
  const timestamp = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`--${name} must be an ISO date or epoch milliseconds`);
  return timestamp;
}

function printCohort(label: string, comparison: SignalQualityComparison): void {
  const c = comparison.selected;
  const b = comparison.baseline;
  const show = (value: number | null, suffix = "") => value === null ? "n/a" : value.toFixed(2) + suffix;
  console.log(`  selected score >= ${comparison.threshold}: n=${c.totalSignals}, ready=${c.readyOutcomes}, coverage=${show(c.coveragePct, "%")}, avg Δviews=${show(c.averageAttentionChangePct, "%")}, median Δviews=${show(c.medianAttentionChangePct, "%")}, positive=${show(c.positiveAttentionRatePct, "%")}`);
  console.log(`  baseline score < ${comparison.threshold}:  n=${b.totalSignals}, ready=${b.readyOutcomes}, coverage=${show(b.coveragePct, "%")}, avg Δviews=${show(b.averageAttentionChangePct, "%")}, median Δviews=${show(b.medianAttentionChangePct, "%")}, positive=${show(b.positiveAttentionRatePct, "%")}`);
  console.log(`  selected minus baseline: avg Δviews lift=${show(comparison.averageChangeLiftPct, " pp")}, positive-rate lift=${show(comparison.positiveRateLiftPct, " pp")}`);
  if (c.totalSignals === 0 || b.totalSignals === 0) {
    console.warn(`  WARNING: ${label} does not contain both selected and baseline cohorts.`);
  }
}

function toOutcome(row: OutcomeRow): SignalQualityOutcome {
  return {
    signal_at: row.signal_at,
    score: row.score,
    outcome_status: row.outcome_status,
    attention_change_pct: row.attention_change_pct,
  };
}

async function main(): Promise<void> {
  const source = (arg("source") ?? "early_signal").toLowerCase();
  if (!VALID_SOURCES.has(source)) throw new Error(`--source must be one of: ${[...VALID_SOURCES].join(", ")}`);

  const horizonHours = numericArg("horizon-hours", 6, 1, 168);
  const lookbackDays = numericArg("lookback-days", 90, 7, 365);
  const threshold = Number(arg("threshold") ?? 60);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    throw new Error("--threshold must be between 0 and 100");
  }
  const minSamples = numericArg("min-samples", 20, 1, 100_000);

  const now = Date.now();
  const from = now - lookbackDays * DAY_MS;
  // Exclude the most recent signals whose full forward observation window has not closed.
  const matureTo = now - (horizonHours + 1) * HOUR_MS;
  if (from >= matureTo) throw new Error("lookback window is too short for the requested outcome horizon");

  const splitAt = arg("split-at")
    ? timestampArg(arg("split-at") as string, "split-at")
    : from + Math.floor((matureTo - from) * 0.7);
  if (splitAt <= from || splitAt >= matureTo) {
    throw new Error("--split-at must fall strictly inside the mature evaluation window");
  }

  console.log("Signal quality validation — observed social attention only (not token price or P&L)");
  console.log(`source=${source} horizon=${horizonHours}h threshold=${threshold} lookback=${lookbackDays}d minSamples=${minSamples}`);
  console.log(`train=[${new Date(from).toISOString()}, ${new Date(splitAt).toISOString()})`);
  console.log(`test =[ ${new Date(splitAt).toISOString()}, ${new Date(matureTo).toISOString()})`);
  console.log("The threshold is fixed before test evaluation. Do not tune it against the test period.");

  const refreshed = await q1<{ refreshed: number }>(
    "SELECT refresh_signal_quality_outcomes($1, $2, $3::integer[]) AS refreshed",
    [from, now, [horizonHours]],
  );
  console.log(`Outcome rows inserted/refreshed: ${refreshed?.refreshed ?? 0}`);

  const dbRows = await q<OutcomeRow>(
    "SELECT signal_at::text, score::text, outcome_status, attention_change_pct::text " +
    "FROM signal_quality_outcomes WHERE source = $1 AND horizon_hours = $2 " +
    "AND signal_at >= $3 AND signal_at < $4 ORDER BY signal_at ASC",
    [source, horizonHours, from, matureTo],
  );
  const rows = dbRows.map(toOutcome);
  const { train, test } = splitSignalOutcomes(rows, splitAt);
  const trainComparison = compareSignalQuality(train, threshold);
  const testComparison = compareSignalQuality(test, threshold);

  console.log(`\nTRAIN (threshold cohort versus below-threshold baseline; rows=${train.length})`);
  printCohort("train", trainComparison);
  console.log(`\nOUT-OF-SAMPLE TEST (rows=${test.length})`);
  printCohort("test", testComparison);

  const insufficient = [
    ["train selected", trainComparison.selected.readyOutcomes],
    ["train baseline", trainComparison.baseline.readyOutcomes],
    ["test selected", testComparison.selected.readyOutcomes],
    ["test baseline", testComparison.baseline.readyOutcomes],
  ].filter(([, count]) => Number(count) < minSamples);
  if (insufficient.length) {
    console.error(`\nINSUFFICIENT EVIDENCE: ready outcomes below --min-samples=${minSamples}: ${insufficient.map(([name, count]) => `${name}=${count}`).join(", ")}`);
    process.exitCode = 2;
  }

  console.log("\nInterpretation limits:");
  console.log("- Outcome = change in aggregate views among collected tweets; it is not full-platform attention or price return.");
  console.log("- Outcomes without a nearby entry snapshot, with fewer than 100 entry views, or without a forward snapshot are not scored.");
  console.log("- Coverage and sample sizes must be reviewed before interpreting uplift; repeated signals may still be correlated.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "signal quality evaluation failed");
  process.exitCode = 1;
}).finally(async () => {
  await closePool().catch(() => {});
});
