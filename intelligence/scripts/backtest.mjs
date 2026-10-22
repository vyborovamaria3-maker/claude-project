#!/usr/bin/env node
import pg from "pg";
import { runSignalBacktest, persistBacktestRun } from "../dist/index.js";

const SIGNAL_COLUMNS = new Set(["attention_score","credibility_score","risk_score","momentum_score"]);
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
  for (const key of ["from","to"]) if (!/^\d{4}-\d{2}-\d{2}$/.test(result[key])) throw new TypeError("invalid_date");
  if (result.from > result.to) throw new TypeError("invalid_date_range");
  const threshold = Number(result.threshold);
  if (!Number.isFinite(threshold)) throw new TypeError("invalid_threshold");
  const horizonHours = Number(result["horizon-hours"] ?? "24");
  if (!Number.isSafeInteger(horizonHours) || horizonHours<1 || horizonHours>720) throw new TypeError("invalid_horizon");
  const baseline = result.baseline ?? "market_average";
  if (baseline!=="market_average" && baseline!=="random") throw new TypeError("invalid_baseline");
  return { ...result, threshold, horizonHours, baseline };
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
    const scoreColumn = args.signal;
    const selected = await client.query(`SELECT s.canonical_token_id,s.as_of AS signal_at,
      s.max_input_observed_at,o.outcome_at,o.observed_at AS outcome_observed_at,
      s.${scoreColumn} AS score,o.label AS outcome,o.value AS outcome_value,o.evidence_ref
      FROM token_daily_cross_platform s
      JOIN LATERAL (
        SELECT outcome_at,observed_at,label,value,evidence_ref
        FROM token_outcomes o
        WHERE o.canonical_token_id=s.canonical_token_id AND o.outcome_kind=$1
          AND o.outcome_at>s.as_of
          AND o.outcome_at<=s.as_of + ($2::integer * INTERVAL '1 hour')
          AND o.observed_at>=o.outcome_at
          AND o.observed_at<=$5::timestamptz
        ORDER BY o.outcome_at ASC,o.observed_at ASC LIMIT 1
      ) o ON TRUE
      WHERE s.day >= $3::date AND s.day <= $4::date
        AND s.as_of <= $5::timestamptz
        AND s.${scoreColumn} IS NOT NULL
        AND s.max_input_observed_at<=s.as_of
      ORDER BY s.as_of,s.canonical_token_id`, [
      args.outcome,args.horizonHours,args.from,args.to,dataCutoffAt,
    ]);
    if (!selected.rows.length) throw new Error("backtest_no_eligible_observations");
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
    await persistBacktestRun(client, {
      runId: result.runId, signalName: args.signal, outcomeKind: args.outcome,
      fromAt, toAt, horizonHours: args.horizonHours, threshold: args.threshold,
      baselineKind: args.baseline, metrics: result.metrics, observations: result.observations,
      dataCutoffAt, featureVersion: null, modelId: null,
    });
    await client.query("COMMIT");
    process.stdout.write(JSON.stringify({ runId: result.runId, signal: args.signal, outcome: args.outcome, from: args.from, to: args.to, metrics: result.metrics })+"\n");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((error) => {
  const code = error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : "backtest_failed";
  process.stderr.write(code+"\n");
  process.exitCode = 1;
});
