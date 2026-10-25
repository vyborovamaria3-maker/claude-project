#!/usr/bin/env node
import pg from "pg";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runSignalBacktest, persistBacktestRun } from "../dist/index.js";

const SIGNAL_COLUMNS = new Set(["attention_score","credibility_score","risk_score","momentum_score"]);
const COVERAGE_PREDICATES = {
  attention_score: `tg_mentions IS NOT NULL AND x_mentions IS NOT NULL
    AND source_coverage->>'tg'='complete' AND source_coverage->>'x'='complete'
    AND chain_swap_evidence_count IS NOT NULL
    AND EXISTS (SELECT 1 FROM source_coverage_windows coverage
      WHERE coverage.source_system='blockchain' AND coverage.scope='token_swap_evidence_revisions'
        AND coverage.status='complete'
        AND coverage.window_start <= (day::timestamp AT TIME ZONE 'UTC')
        AND coverage.window_end >= ((day + 1)::timestamp AT TIME ZONE 'UTC')
        AND coverage.known_at <= as_of AND coverage.created_at <= as_of)`,
  credibility_score: `tg_copypasta_ratio IS NOT NULL AND x_bot_ratio IS NOT NULL
    AND source_coverage->>'tg'='complete' AND source_coverage->>'x'='complete'`,
  risk_score: `tg_scam_ratio IS NOT NULL AND x_bot_ratio IS NOT NULL AND chain_rug_risk IS NOT NULL
    AND source_coverage->>'tg'='complete' AND source_coverage->>'x'='complete'
    AND source_coverage->>'blockchain'='complete'`,
  momentum_score: `tg_mentions_z_1h IS NOT NULL AND x_mentions_z_1h IS NOT NULL AND chain_volume_z_1h IS NOT NULL
    AND source_coverage->>'tg'='complete' AND source_coverage->>'x'='complete'
    AND EXISTS (SELECT 1 FROM source_coverage_windows coverage
      WHERE coverage.source_system='blockchain' AND coverage.scope='settled_trade_tape'
        AND coverage.status='complete'
        AND coverage.window_start <= (day::timestamp AT TIME ZONE 'UTC')
        AND coverage.window_end >= ((day + 1)::timestamp AT TIME ZONE 'UTC')
        AND coverage.known_at <= as_of AND coverage.created_at <= as_of)`,
};
function isUtcDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value;
}
function parseArgs(argv) {
  const result = {};
  for (let i=0;i<argv.length;i++) {
    const key = argv[i];
    if (!key.startsWith("--") || i+1>=argv.length || Object.hasOwn(result,key.slice(2))) {
      throw new TypeError("invalid_arguments");
    }
    result[key.slice(2)] = argv[++i];
  }
  const allowed = new Set(["signal","outcome","from","to","threshold","horizon-hours","baseline","seed"]);
  if (Object.keys(result).some((key)=>!allowed.has(key))) throw new TypeError("unknown_argument");
  for (const required of ["signal","outcome","from","to","threshold"]) {
    if (typeof result[required] !== "string") throw new TypeError("missing_"+required);
  }
  if (!SIGNAL_COLUMNS.has(result.signal)) throw new TypeError("invalid_signal");
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(result.outcome)) throw new TypeError("invalid_outcome");
  for (const key of ["from","to"]) if (!isUtcDate(result[key])) throw new TypeError("invalid_date");
  if (result.from > result.to) throw new TypeError("invalid_date_range");
  const threshold = Number(result.threshold);
  if (!Number.isFinite(threshold)) throw new TypeError("invalid_threshold");
  const horizonHours = Number(result["horizon-hours"] ?? "24");
  if (!Number.isSafeInteger(horizonHours) || horizonHours<1 || horizonHours>720) throw new TypeError("invalid_horizon");
  const baseline = result.baseline ?? "market_average";
  if (baseline!=="market_average" && baseline!=="random") throw new TypeError("invalid_baseline");
  return { ...result, threshold, horizonHours, baseline };
}
export async function selectBacktestObservations(client, args, dataCutoffAt) {
    if (!SIGNAL_COLUMNS.has(args.signal)) throw new TypeError("invalid_signal");
    const scoreColumn = args.signal;
    const coveragePredicate = COVERAGE_PREDICATES[scoreColumn];
    // Filter by availability before choosing the last signal per token/UTC signal day.
    return client.query(`WITH available_snapshots AS (
      SELECT *, GREATEST(as_of,created_at) AS signal_at
      FROM token_daily_cross_platform
      WHERE max_input_observed_at<=as_of
        AND ${scoreColumn} IS NOT NULL
        AND (${coveragePredicate})
    ), daily_snapshots AS (
      SELECT DISTINCT ON (canonical_token_id,(signal_at AT TIME ZONE 'UTC')::date) *
      FROM available_snapshots
      WHERE signal_at >= ($3::date::timestamp AT TIME ZONE 'UTC')
        AND signal_at < (($4::date + 1)::timestamp AT TIME ZONE 'UTC')
        AND signal_at <= $5::timestamptz
      ORDER BY canonical_token_id,(signal_at AT TIME ZONE 'UTC')::date,
        signal_at DESC,day DESC,as_of DESC
    )
    SELECT s.canonical_token_id,s.signal_at,s.score_version,
      (s.signal_at + ($2::integer * INTERVAL '1 hour') <= $5::timestamptz) AS horizon_complete,
       s.max_input_observed_at,o.outcome_at,o.observed_at AS outcome_observed_at,
      o.outcome_match_count,s.${scoreColumn} AS score,o.label AS outcome,o.value AS outcome_value,o.evidence_ref
      FROM daily_snapshots s
      LEFT JOIN LATERAL (
        SELECT outcome_at,observed_at,label,value,evidence_ref,
          COUNT(*) OVER() AS outcome_match_count
        FROM token_outcomes o
        WHERE o.canonical_token_id=s.canonical_token_id AND o.outcome_kind=$1
          AND o.outcome_at>s.signal_at
          AND o.outcome_at<=s.signal_at + ($2::integer * INTERVAL '1 hour')
          AND o.observed_at>=o.outcome_at
          AND o.observed_at<=$5::timestamptz AND o.created_at<=$5::timestamptz
        ORDER BY o.outcome_at ASC,o.observed_at ASC LIMIT 1
      ) o ON TRUE
      ORDER BY s.signal_at,s.canonical_token_id`, [
      args.outcome,args.horizonHours,args.from,args.to,dataCutoffAt,
    ]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connectionString = process.env.INTELLIGENCE_DATABASE_URL;
  if (!connectionString) throw new Error("database_config_required");
  const fromAt = new Date(args.from+"T00:00:00.000Z");
  const toAt = new Date(args.to+"T23:59:59.999Z");
  const pool = new pg.Pool({
    connectionString, max: 2, connectionTimeoutMillis: 3000,
    query_timeout: 10000, statement_timeout: 8000,
    options: "-c statement_timeout=8000",
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const cutoffResult = await client.query("SELECT transaction_timestamp() AS cutoff");
    const dataCutoffAt = cutoffResult.rows[0]?.cutoff;
    if (!(dataCutoffAt instanceof Date) || toAt > dataCutoffAt) {
      throw new TypeError("backtest_range_must_be_historical");
    }
    const selected = await selectBacktestObservations(client,args,dataCutoffAt);
    if (!selected.rows.length) throw new Error("backtest_no_eligible_observations");
    // Fail closed: neither incomplete horizons nor missing outcomes may disappear from the denominator.
    const incompleteHorizonCount=selected.rows.filter((row)=>row.horizon_complete!==true).length;
    const missingOutcomeCount=selected.rows.filter((row)=>row.outcome_at===null||row.outcome_at===undefined).length;
    const ambiguousOutcomeCount=selected.rows.filter(row=>Number(row.outcome_match_count)>1).length;
    const coverage={eligibleCount:selected.rows.length,
      completedHorizonCount:selected.rows.length-incompleteHorizonCount,
      labeledCount:selected.rows.length-missingOutcomeCount,
      incompleteHorizonCount,missingOutcomeCount,ambiguousOutcomeCount};
    if(incompleteHorizonCount||missingOutcomeCount||ambiguousOutcomeCount){
      process.stderr.write(JSON.stringify({outcomeCoverage:coverage})+"\n");
      throw new Error(incompleteHorizonCount?"backtest_incomplete_horizon":
        missingOutcomeCount?"backtest_incomplete_outcome_coverage":"backtest_ambiguous_outcome_labels");
    }
    const versions=[...new Set(selected.rows.map(row=>row.score_version))];
    if(versions.length!==1||typeof versions[0]!=="string"||!versions[0])
      throw new Error("backtest_mixed_score_versions");
    const observations = selected.rows.map((row) => ({
      canonicalTokenId: row.canonical_token_id,
      signalAt: row.signal_at,
      maxInputObservedAt: row.max_input_observed_at,
      outcomeAt: row.outcome_at,
      outcomeObservedAt: row.outcome_observed_at,
      score: Number(row.score),
      outcome: row.outcome === true,
      outcomeValue: row.outcome_value === null ? null : Number(row.outcome_value),
      evidenceRef: row.evidence_ref ?? null,
    }));
    const result = runSignalBacktest(observations, {
      threshold: args.threshold, baseline: args.baseline, seed: args.seed ?? "cross-platform-backtest-v1",
    });
    const metrics={...result.metrics,outcomeCoverage:coverage};
    await persistBacktestRun(client, {
      runId: result.runId, signalName: args.signal, outcomeKind: args.outcome,
      fromAt, toAt, horizonHours: args.horizonHours, threshold: args.threshold,
      baselineKind: args.baseline, metrics, observations: result.observations,
      dataCutoffAt, featureVersion: versions[0], modelId: null,
    });
    await client.query("COMMIT");
    process.stdout.write(JSON.stringify({ runId: result.runId, signal: args.signal, outcome: args.outcome, from: args.from, to: args.to, metrics })+"\n");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main().catch((error) => {
  const code = error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : "backtest_failed";
  process.stderr.write(code+"\n");
  process.exitCode = 1;
});
