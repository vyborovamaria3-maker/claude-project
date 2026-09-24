import { q, q1, closePool } from "../lib/trade/pg";
import * as fs from "node:fs";
import * as path from "node:path";

interface BacktestRun {
  id: string; name: string; params: any; metric_basis: string; notes: string | null;
  started_at: string; finished_at: string | null;
  signals_count: number; avg_views_change_pct: string; median_views_change_pct: string;
  positive_attention_rate: string; min_views_change_pct: string;
}

interface BacktestTrade {
  mint: string; signal_at: string; entry_score: string;
  entry_views: string; exit_views: string; views_change_pct: string; hold_hours: number;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      flags[k] = v ?? args[++i] ?? "true";
    } else positional.push(a);
  }
  return { cmd, positional, flags };
}

async function runSingle(strategy: string, holdHours: number, days: number) {
  const from = Date.now() - days * 86400000;
  const runName = `${strategy}-h${holdHours}-${new Date().toISOString().slice(0, 10)}`;
  console.log(`\n▶️  ${runName} | hold=${holdHours}ч days=${days}`);
  console.log("⚠️  Это изменение просмотров в собранном наборе постов; не активность всего X, цена токена или торговый P&L.");
  const r = await q1<{ backtest_strategy: string }>(
    `SELECT backtest_strategy($1, $2, $3, $4, NULL, 0)`,
    [strategy, runName, holdHours, from]
  );
  return Number(r?.backtest_strategy);
}

async function showRun(runId: number) {
  const run = await q1<BacktestRun>(
    `SELECT id::text, name, params, metric_basis, notes, started_at::text, finished_at::text,
            signals_count, avg_views_change_pct::text, median_views_change_pct::text,
            positive_attention_rate::text, min_views_change_pct::text
     FROM backtest_runs WHERE id = $1`, [runId]
  );
  if (!run) { console.log("Прогон не найден"); return; }

  console.log(`\n━━━ #${run.id}: ${run.name} ━━━`);
  console.log(`Метрика:        ${run.metric_basis}`);
  console.log(`Параметры:      ${JSON.stringify(run.params)}`);
  console.log(`Сигналов:       ${run.signals_count}`);
  console.log(`Среднее Δ views:${run.avg_views_change_pct}%`);
  console.log(`Медиана Δ views:${run.median_views_change_pct}%`);
  console.log(`С положит. Δ:   ${(Number(run.positive_attention_rate) * 100).toFixed(1)}%`);
  console.log(`Мин. Δ views:   ${run.min_views_change_pct}%`);
  if (run.notes) console.log(`Примечание:     ${run.notes}`);

  const dist = await q<{ bucket: string; n: number }>(
    `SELECT CASE
       WHEN views_change_pct < -50 THEN '<-50%'
       WHEN views_change_pct < -20 THEN '-50..-20%'
       WHEN views_change_pct < 0 THEN '-20..0%'
       WHEN views_change_pct < 20 THEN '0..20%'
       WHEN views_change_pct < 50 THEN '20..50%'
       WHEN views_change_pct < 100 THEN '50..100%'
       WHEN views_change_pct < 500 THEN '100..500%'
       ELSE '500%+'
     END AS bucket, COUNT(*)::int AS n
     FROM backtest_trades WHERE run_id = $1 AND views_change_pct IS NOT NULL
     GROUP BY bucket ORDER BY MIN(views_change_pct)`, [runId]
  );
  console.log("\nРаспределение изменения просмотров:");
  for (const d of dist) {
    const bar = "█".repeat(Math.min(50, Math.ceil(d.n / 2)));
    console.log(`  ${d.bucket.padEnd(12)} ${String(d.n).padStart(5)} ${bar}`);
  }

  const top = await q<BacktestTrade>(
    `SELECT mint, signal_at::text, entry_score::text, entry_views::text,
            exit_views::text, views_change_pct::text, hold_hours
     FROM backtest_trades WHERE run_id = $1 AND views_change_pct IS NOT NULL
     ORDER BY views_change_pct DESC LIMIT 10`, [runId]
  );
  console.log("\nТоп-10:");
  console.table(top.map((t) => ({
    mint: t.mint.slice(0, 8) + "…",
    entry_score: Number(t.entry_score).toFixed(1),
    entry_views: Number(t.entry_views).toLocaleString(),
    exit_views: Number(t.exit_views).toLocaleString(),
    views_change: t.views_change_pct + "%",
  })));

  const worst = await q<BacktestTrade>(
    `SELECT mint, views_change_pct::text FROM backtest_trades
     WHERE run_id = $1 AND views_change_pct IS NOT NULL ORDER BY views_change_pct ASC LIMIT 5`, [runId]
  );
  console.log("\nХудшие 5:");
  console.table(worst.map((t) => ({ mint: t.mint.slice(0, 8) + "…", views_change: t.views_change_pct + "%" })));
}

async function sweep(strategy: string, thresholds: number[], holds: number[], days: number) {
  console.log(`\n🔬 SOCIAL-ATTENTION SWEEP strategy=${strategy} thresholds=[${thresholds.join(",")}] holds=[${holds.join(",")}] days=${days}\n`);
  console.log("⚠️  Измеряется изменение просмотров только в собранном наборе постов; это не рыночная доходность.");
  const results: any[] = [];

  for (const hold of holds) {
    for (const thr of thresholds) {
      const stratName = `${strategy}_thr${thr}`;
      const source = strategy.includes("hype") ? "hype" : strategy.includes("ultra") ? "ultra" : "early_signal";
      const baseSql = `SELECT mint, signal_at, score FROM signal_history WHERE source = '${source}' AND score >= ${thr}`;

      await q(
        `INSERT INTO strategies (name, description, rule_sql, created_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (name) DO UPDATE SET rule_sql = EXCLUDED.rule_sql`,
        [stratName, `Auto ${strategy} thr=${thr}`, baseSql, Date.now()]
      );

      const runName = `sweep-${strategy}-thr${thr}-h${hold}-${Date.now()}`;
      const from = Date.now() - days * 86400000;

      try {
        const r = await q1<{ backtest_strategy: string }>(
          `SELECT backtest_strategy($1, $2, $3, $4, NULL, 0)`,
          [stratName, runName, hold, from]
        );
        const runId = Number(r?.backtest_strategy);
        const run = await q1<BacktestRun>(
          `SELECT signals_count, avg_views_change_pct::text, positive_attention_rate::text,
                  min_views_change_pct::text
           FROM backtest_runs WHERE id = $1`, [runId]
        );
        if (run) {
          results.push({
            threshold: thr, hold, signals: run.signals_count,
            avg_views_change: Number(run.avg_views_change_pct ?? 0),
            positive_attention_rate: Number(run.positive_attention_rate ?? 0),
            min_views_change: Number(run.min_views_change_pct ?? 0),
            run_id: runId,
          });
        }
      } catch (e) { console.warn(`  thr=${thr} hold=${hold} — ошибка: ${e}`); }
    }
  }

  results.sort((a, b) => b.avg_views_change - a.avg_views_change);
  console.log("\n📊 Результаты (по среднему изменению просмотров; не по P&L):");
  console.table(results.map((r) => ({
    thr: r.threshold, hold: r.hold, signals: r.signals,
    avg_views_change: r.avg_views_change.toFixed(2) + "%",
    positive_attention: (r.positive_attention_rate * 100).toFixed(1) + "%",
    min_views_change: r.min_views_change.toFixed(1) + "%",
    run_id: r.run_id,
  })));
  console.log("\n🏆 Топ-3 по среднему изменению просмотров:");
  for (const r of results.slice(0, 3)) {
    console.log(`   thr=${r.threshold} hold=${r.hold}h → avg Δ views=${r.avg_views_change.toFixed(2)}% positive=${(r.positive_attention_rate * 100).toFixed(1)}%`);
  }
}

async function listRuns() {
  const runs = await q<BacktestRun>(
    `SELECT id::text, name, params, metric_basis, notes, started_at::text, finished_at::text,
            signals_count, avg_views_change_pct::text, median_views_change_pct::text,
            positive_attention_rate::text, min_views_change_pct::text
     FROM backtest_runs ORDER BY started_at DESC LIMIT 30`
  );
  console.log("\n📜 Последние прогоны:");
  console.table(runs.map((r) => ({
    id: r.id, name: r.name.slice(0, 40), signals: r.signals_count,
    avg_views_change: r.avg_views_change_pct ? Number(r.avg_views_change_pct).toFixed(1) + "%" : "—",
    positive_attention: r.positive_attention_rate ? (Number(r.positive_attention_rate) * 100).toFixed(1) + "%" : "—",
    min_views_change: r.min_views_change_pct ? Number(r.min_views_change_pct).toFixed(1) + "%" : "—",
    metric: r.metric_basis,
  })));
}

async function exportRun(runId: number, format: "csv" | "json") {
  const trades = await q(
    `SELECT mint, signal_at, entry_score, entry_views, exit_views,
            views_change_pct, hold_hours
     FROM backtest_trades WHERE run_id = $1 ORDER BY signal_at`, [runId]
  );
  const outDir = path.join(process.cwd(), "exports", "backtests");
  fs.mkdirSync(outDir, { recursive: true });

  if (format === "csv") {
    const headers = ["mint", "signal_at", "entry_score", "entry_views", "exit_views", "views_change_pct", "hold_hours"];
    const lines = [headers.join(",")];
    for (const t of trades) lines.push(headers.map((h) => String((t as any)[h] ?? "")).join(","));
    const file = path.join(outDir, `backtest-${runId}.csv`);
    fs.writeFileSync(file, lines.join("\n"));
    console.log(`✓ ${file} (${trades.length} строк)`);
  } else {
    const file = path.join(outDir, `backtest-${runId}.json`);
    fs.writeFileSync(file, JSON.stringify(trades, null, 2));
    console.log(`✓ ${file}`);
  }
}

async function trainML(horizon: number) {
  console.log(`\n🧠 Обучение модели наблюдаемого роста просмотров на ${horizon}ч...`);
  const r = await q1<{ build_training_data: number }>(`SELECT build_training_data($1, 12)`, [horizon]);
  console.log(`Снапшотов: ${r?.build_training_data ?? 0}`);

  const stats = await q1<{ total: string; growth_50: string }>(
    `SELECT COUNT(*)::text AS total,
            COUNT(*) FILTER (WHERE label_views_growth_50)::text AS growth_50
     FROM ml_feature_snapshots
     WHERE horizon_h = $1 AND label_basis = 'observed_dataset_views'
       AND label_views_growth_50 IS NOT NULL`, [horizon]
  );
  const total = Number(stats?.total ?? 0);
  const growth50 = Number(stats?.growth_50 ?? 0);
  console.log(`Всего: ${total}, снимков с ростом просмотров собранного набора ≥50%: ${growth50} (${total ? ((growth50 / total) * 100).toFixed(1) : 0}%)`);

  if (total < 100) { console.log("❌ Мало данных (< 100)"); return; }

  const model = await q1<{ train_logistic_regression: string }>(
    `SELECT train_logistic_regression($1, $2, 0.01, 500, 0.001)`,
    [`model-h${horizon}-${Date.now()}`, horizon]
  );
  const modelId = Number(model?.train_logistic_regression);

  const m = await q1<any>(
    `SELECT name, train_samples, train_accuracy::text, train_logloss::text,
            test_samples, test_accuracy::text, test_logloss::text
     FROM ml_models WHERE id = $1`, [modelId]
  );
  console.log(`\n✅ Модель #${modelId}: ${m?.name} (цель: рост наблюдаемых views собранного набора ≥50%; не прогноз цены токена)`);
  console.log(`   Train: ${m?.train_samples} snapshots, accuracy=${m?.train_accuracy}`);
  console.log(`   Test:  ${m?.test_samples} snapshots, accuracy=${m?.test_accuracy}`);

  const coefs = await q1<any>(`SELECT feature_names, coefficients FROM ml_models WHERE id = $1`, [modelId]);
  console.log("\nКоэффициенты:");
  const pairs = (coefs.feature_names as string[]).map((n, i) => ({ feature: n, coef: Number(coefs.coefficients[i]) }));
  pairs.sort((a, b) => Math.abs(b.coef) - Math.abs(a.coef));
  for (const p of pairs) console.log(`   ${p.coef > 0 ? "↑" : "↓"} ${p.feature.padEnd(20)} ${p.coef.toFixed(4)}`);
}

async function main() {
  const { cmd, positional, flags } = parseArgs();
  try {
    if (cmd === "train") {
      const horizon = Number(flags.horizon ?? 6);
      if (!Number.isInteger(horizon) || horizon < 1 || horizon > 720) throw new Error("horizon must be an integer from 1 to 720");
      await trainML(horizon); return;
    }
    if (cmd === "run") {
      const strategy = positional[0];
      if (!strategy) throw new Error("Укажи strategy");
      if (flags.fee !== undefined && Number(flags.fee) !== 0) throw new Error("Fees are not applicable to a views-only proxy; omit --fee or set --fee 0");
      const hold = Number(flags.hold ?? 6);
      const days = Number(flags.days ?? 30);
      if (!Number.isInteger(hold) || hold < 1 || hold > 720) throw new Error("hold must be an integer from 1 to 720 hours");
      if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error("days must be an integer from 1 to 3650");
      const runId = await runSingle(strategy, hold, days);
      await showRun(runId);
      return;
    }
    if (cmd === "sweep") {
      const strategy = positional[0];
      if (!strategy) throw new Error("Укажи strategy");
      const thresholds = (flags.thresholds ?? "40,50,60,70,80").split(",").map(Number);
      const holds = (flags.holds ?? "1,3,6,12,24").split(",").map(Number);
      const days = Number(flags.days ?? 30);
      if (!thresholds.length || thresholds.some((n) => !Number.isFinite(n) || n < 0 || n > 100)) throw new Error("thresholds must be numbers from 0 to 100");
      if (!holds.length || holds.some((n) => !Number.isInteger(n) || n < 1 || n > 720)) throw new Error("holds must be integers from 1 to 720 hours");
      if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error("days must be an integer from 1 to 3650");
      await sweep(strategy, thresholds, holds, days);
      return;
    }
    if (cmd === "list") { await listRuns(); return; }
    if (cmd === "show") {
      const runId = Number(positional[0]);
      if (!Number.isInteger(runId) || runId < 1) throw new Error("show requires a positive run id");
      await showRun(runId); return;
    }
    if (cmd === "export") {
      const runId = Number(positional[0]);
      const format = flags.format ?? "csv";
      if (!Number.isInteger(runId) || runId < 1) throw new Error("export requires a positive run id");
      if (format !== "csv" && format !== "json") throw new Error("format must be csv or json");
      await exportRun(runId, format); return;
    }

    console.log(`Использование:
  train [--horizon 6]
  run <strategy> [--hold 6] [--days 30]
  sweep <strategy> [--thresholds 40,50,60] [--holds 1,3,6] [--days 30]
  (Результаты выражены в изменении просмотров и не являются доходностью/торговым P&L.)
  list
  show <run_id>
  export <run_id> [--format csv|json]

Стратегии: hype_gt_60, ultra_gt_70, early_signal, или auto-сгенерённые (hype_gt_60_thr60)
`);
  } finally {
    await closePool();
  }
}

main().catch((e) => { console.error("❌", e instanceof Error ? e.message : e); process.exit(1); });

