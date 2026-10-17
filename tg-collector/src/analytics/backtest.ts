import "dotenv/config";
import { pool, migrate } from "../db.js";
import { OUTCOME_VERSION } from "./token-intelligence.js";

function arg(name: string): string | undefined {
  return process.argv.find((value) => value.startsWith("--" + name + "="))?.slice(name.length + 3);
}
function requiredDate(name: string): Date {
  const raw = arg(name);
  if (!raw) throw new Error("Missing --" + name + "=ISO_DATE");
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) throw new Error("Invalid --" + name + " date");
  return parsed;
}

/**
 * Chronological evaluation of already-recorded signals. This does not train a model and
 * cannot use market data that was not actually observed near the event time.
 */
async function main(): Promise<void> {
  await migrate();
  const from = requiredDate("from");
  const testStart = requiredDate("test-start");
  const to = requiredDate("to");
  if (!(from < testStart && testStart < to)) {
    throw new Error("Require --from < --test-start < --to for a time-based holdout");
  }
  const name = arg("name") ?? "chronological-signal-evaluation";
  const client = await pool.connect();
  let runId: string | undefined;
  try {
    await client.query("BEGIN");
    const run = await client.query<{id: string}>(
      "INSERT INTO tg_backtest_runs(name,model_version,time_start,time_end,parameters,baseline_name,status,started_at) " +
      "VALUES($1,'signal-eval-v1',$2,$3,$4::jsonb,'equal_weight_token_universe','running',now()) RETURNING id::text",
      [name, from, to, JSON.stringify({ split: "chronological", testStart, outcomesModel: OUTCOME_VERSION,
        signalStatusFilter: ["candidate", "reviewed", "validated"], marketPricesRequireObservedSnapshots: true })],
    );
    runId = run.rows[0].id;
    const baseline = await client.query<{baseline_return: string | null}>(
      "SELECT avg((o.price_24h/o.price_at_mention-1)*100)::text AS baseline_return " +
      "FROM tg_token_outcomes o WHERE o.model_version=$1 AND o.outcome_status='complete' " +
      "AND o.mention_time >= $2 AND o.mention_time < $3 AND o.price_at_mention>0 AND o.price_24h>0",
      [OUTCOME_VERSION, testStart, to],
    );
    const baselineReturn = baseline.rows[0]?.baseline_return === null || baseline.rows[0]?.baseline_return === undefined
      ? null : Number(baseline.rows[0].baseline_return);
    await client.query(
      "INSERT INTO tg_backtest_results(run_id,signal_id,chain_id,mint,source_id,message_id,outcome_horizon," +
      "forward_return_pct,max_drawdown_pct,baseline_return_pct,labels) " +
      "SELECT $1,s.id,s.chain_id,s.mint,s.source_id,s.message_id,'24h'," +
      "((o.price_24h/o.price_at_mention-1)*100),o.max_drawdown_pct,$2," +
      "jsonb_build_object('signal_type',s.signal_type,'signal_model_version',s.model_version," +
      "'outcome_model_version',o.model_version,'market_provider',o.market_provider) " +
      "FROM tg_signals s JOIN tg_token_outcomes o ON o.chain_id=s.chain_id AND o.mint=s.mint " +
      "AND o.source_id=s.source_id AND o.message_id=s.message_id " +
      "WHERE s.detected_at >= $3 AND s.detected_at < $4 AND s.status <> 'dismissed' " +
      "AND o.model_version=$5 AND o.outcome_status='complete' " +
      "AND o.mention_time >= $3 AND o.mention_time < $4 AND o.price_at_mention>0 AND o.price_24h>0 " +
      "ON CONFLICT(run_id,signal_id) DO NOTHING",
      [runId, baselineReturn, testStart, to, OUTCOME_VERSION],
    );
    const metrics = await client.query<{
      sample_size: number; avg_return: string | null; median_return: string | null;
      win_rate: string | null; avg_drawdown: string | null; baseline_return: string | null;
    }>(
      "SELECT count(*)::integer AS sample_size,avg(forward_return_pct)::text AS avg_return," +
      "percentile_cont(0.5) WITHIN GROUP(ORDER BY forward_return_pct)::text AS median_return," +
      "avg(CASE WHEN forward_return_pct>0 THEN 1.0 ELSE 0.0 END)::text AS win_rate," +
      "avg(max_drawdown_pct)::text AS avg_drawdown,avg(baseline_return_pct)::text AS baseline_return " +
      "FROM tg_backtest_results WHERE run_id=$1",
      [runId],
    );
    const row = metrics.rows[0];
    const summary = {
      sampleSize: row?.sample_size ?? 0,
      averageReturnPct: row?.avg_return === null || row?.avg_return === undefined ? null : Number(row.avg_return),
      medianReturnPct: row?.median_return === null || row?.median_return === undefined ? null : Number(row.median_return),
      winRate: row?.win_rate === null || row?.win_rate === undefined ? null : Number(row.win_rate),
      averageMaxDrawdownPct: row?.avg_drawdown === null || row?.avg_drawdown === undefined ? null : Number(row.avg_drawdown),
      equalWeightUniverseBaselineReturnPct: row?.baseline_return === null || row?.baseline_return === undefined ? null : Number(row.baseline_return),
      testStart: testStart.toISOString(), testEnd: to.toISOString(),
      warning: "Historical correlation is not proof of causality; no trading is performed.",
    };
    await client.query(
      "UPDATE tg_backtest_runs SET status='completed',metrics=$2::jsonb,finished_at=now() WHERE id=$1",
      [runId, JSON.stringify(summary)],
    );
    await client.query("COMMIT");
    console.log(JSON.stringify({ runId, ...summary }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK");
    if (runId) {
      await pool.query("UPDATE tg_backtest_runs SET status='failed',finished_at=now() WHERE id=$1", [runId]).catch(() => {});
    }
    throw error;
  } finally {
    client.release();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(() => pool.end());
