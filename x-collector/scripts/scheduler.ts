import { enqueueTask } from "../lib/trade/tasks";
import { q, tx } from "../lib/trade/pg";
import { log } from "../lib/trade/logger";
import { scoreSentimentForRecent, scoreToxicityForRecent, extractEntitiesForRecent } from "../lib/trade/analytics-nlp";
import { rebuildAuthorReputation, rebuildAuthorBehavior } from "../lib/trade/analytics-kol";
import { rebuildClusters } from "../lib/trade/analytics-clusters";
import {
  rebuildMintMetrics1m, rebuildMintMetrics1h, rollupMint1d, rollupMint1w,
  rebuildAuthorMetrics1d,
} from "../lib/trade/analytics-timeseries";
import { detectViral } from "../lib/trade/analytics-events";
import {
  rebuildHypeScores, rebuildMintSimilarity, rebuildLeadStats, rebuildPageRank,
  rebuildUltraScores,
} from "../lib/trade/analytics-advanced";

interface TaskDef {
  name: string;
  intervalMs: number;
  run: () => Promise<void>;
}

const runningTasks = new Set<string>();

const tasks: TaskDef[] = [
  {
    name: "enqueue-timelines",
    intervalMs: 30 * 60_000,
    run: async () => {
      const now = Date.now();
      const rows = await q<{ handle: string; mint: string }>(
        `SELECT DISTINCT l.handle, l.mint
         FROM tweet_token_links l
         JOIN twitter_tweets t ON t.tweet_id = l.tweet_id
         WHERE t.posted_at >= $1
           AND NOT EXISTS (
             SELECT 1 FROM x_tasks k
             WHERE k.handle = l.handle AND k.mint = l.mint AND k.kind = 'timeline'
               AND (k.status IN ('pending','claimed') OR
                    (k.status = 'done' AND k.updated_at >= $2))
           )
         ORDER BY l.mint, l.handle
         LIMIT 300`,
        [now - 30 * 86_400_000, now - 86_400_000]
      );
      for (const r of rows) {
        await enqueueTask({
          kind: "timeline",
          payload: { handle: r.handle, limit: 200 },
          handle: r.handle, mint: r.mint, priority: 1, dedup: true,
          // One refresh per handle/mint per UTC day; a completed task can be enqueued again tomorrow.
          idempotencyKey: `timeline:${r.mint}:${r.handle}:${Math.floor(Date.now() / 86400000)}`,
        });
      }
      log.info("enqueued timelines", { n: rows.length });
    },
  },
  {
    name: "rebuild-cooccurrence",
    intervalMs: 60 * 60_000,
    run: async () => {
      await tx(async (c) => {
        await c.query(`SET LOCAL statement_timeout = '300000'`);
        await c.query(`DELETE FROM author_cooccurrence`);
        await c.query(
          `WITH pairs AS (
             SELECT a.handle AS ha, b.handle AS hb, COUNT(DISTINCT a.mint) AS shared
             FROM tweet_token_links a
             JOIN tweet_token_links b ON a.mint = b.mint AND a.handle < b.handle
             GROUP BY a.handle, b.handle
           )
           INSERT INTO author_cooccurrence (handle_a, handle_b, shared_mints, last_seen)
           SELECT ha, hb, shared, $1 FROM pairs
           WHERE shared >= 2 AND shared <= 1000
           ORDER BY shared DESC LIMIT 50000`,
          [Date.now()]
        );
      });
      log.info("cooccurrence rebuilt");
    },
  },
  {
    name: "refresh-mvs",
    intervalMs: 30 * 60_000,
    run: async () => {
      // CONCURRENTLY refreshes must be top-level statements, not wrapped in a PL/pgSQL function.
      const views = [
        "mv_author_token_stats", "mv_author_cooccurrence", "mv_daily_mint_stats",
        "mv_top_authors", "mv_shillers", "mv_coordinated",
        "mv_mint_sentiment_daily", "mv_author_sentiment", "mv_mint_first_movers",
      ];
      for (const view of views) await q(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`);
      log.info("MVs refreshed", { count: views.length });
    },
  },
  {
    name: "retention",
    intervalMs: 24 * 3600_000,
    run: async () => {
      const r = await q<{ table_name: string; deleted: string }>(`SELECT * FROM apply_retention(false)`);
      log.info("retention applied", { tables: r.map(x => ({ t: x.table_name, n: x.deleted })) });
    },
  },
  {
    name: "snapshot-sizes",
    intervalMs: 6 * 3600_000,
    run: async () => { await q(`SELECT snapshot_table_sizes()`); },
  },
  {
    name: "promote-accounts",
    intervalMs: 6 * 3600_000,
    run: async () => {
      const now = Date.now();
      const r1 = await q(
        `UPDATE x_accounts SET tier='warm', weight_quota_per_hour=60, updated_at=$1
         WHERE tier='new' AND status='active' AND consecutive_errors=0
           AND total_requests >= 30 AND created_at < $2 RETURNING name`,
        [now, now - 86_400_000]
      );
      const r2 = await q(
        `UPDATE x_accounts SET tier='hot', weight_quota_per_hour=120, updated_at=$1
         WHERE tier='warm' AND status='active' AND consecutive_errors=0
           AND total_requests >= 500 AND created_at < $2 RETURNING name`,
        [now, now - 3 * 86_400_000]
      );
      log.info("accounts promoted", { toWarm: r1.length, toHot: r2.length });
    },
  },
  {
    name: "nlp-sentiment",
    intervalMs: 10 * 60_000,
    run: async () => { const n = await scoreSentimentForRecent(5000); log.info("sentiment scored", { n }); },
  },
  {
    name: "nlp-toxicity",
    intervalMs: 10 * 60_000,
    run: async () => { const n = await scoreToxicityForRecent(5000); log.info("toxicity scored", { n }); },
  },
  {
    name: "nlp-entities",
    intervalMs: 15 * 60_000,
    run: async () => { const n = await extractEntitiesForRecent(3000); log.info("entities extracted", { n }); },
  },
  {
    name: "timeseries-1m",
    intervalMs: 5 * 60_000,
    run: async () => {
      const minuteRows = await rebuildMintMetrics1m(Date.now() - 60 * 60_000);
      log.info("minute time-series rebuilt", { minuteRows });
    },
  },
  {
    name: "timeseries-rollup-1d",
    intervalMs: 60 * 60_000,
    run: async () => {
      const from = Date.now() - 7 * 86400000;
      const dailyRows = await rollupMint1d(from);
      const authorRows = await rebuildAuthorMetrics1d(Date.now() - 90 * 86400000);
      log.info("daily time-series rebuilt", { dailyRows, authorRows });
    },
  },
  {
    name: "timeseries-rollup-1w",
    intervalMs: 24 * 3600_000,
    run: async () => {
      const n = await rollupMint1w(Date.now() - 365 * 86400000);
      log.info("weekly time-series rebuilt", { n });
    },
  },
  {
    name: "author-reputation",
    intervalMs: 30 * 60_000,
    run: async () => { const n = await rebuildAuthorReputation(); log.info("reputation rebuilt", { n }); },
  },
  {
    name: "author-behavior",
    intervalMs: 60 * 60_000,
    run: async () => { const n = await rebuildAuthorBehavior(); log.info("behavior rebuilt", { n }); },
  },
  {
    name: "clusters",
    intervalMs: 6 * 3600_000,
    run: async () => { const n = await rebuildClusters(2); log.info("clusters rebuilt", { n }); },
  },
  {
    name: "viral-events",
    intervalMs: 15 * 60_000,
    run: async () => { const n = await detectViral(); log.info("viral events detected", { n }); },
  },
  {
    name: "history-snapshots",
    intervalMs: 10 * 60_000,
    run: async () => {
      const hourRows = await rebuildMintMetrics1h(Date.now() - 48 * 3600_000);
      const hypeRows = await rebuildHypeScores();
      const ultraRows = await rebuildUltraScores();
      const attention = await q<{ capture_mint_attention_snapshots: number }>(`SELECT capture_mint_attention_snapshots()`);
      const signals = await q<{ capture_signal_history: number }>(`SELECT capture_signal_history()`);
      log.info("historical observations captured", {
        hourRows, hypeRows, ultraRows,
        attentionRows: attention[0]?.capture_mint_attention_snapshots ?? 0,
        signalRows: signals[0]?.capture_signal_history ?? 0,
      });
    },
  },
  {
    name: "mint-similarity",
    intervalMs: 6 * 3600_000,
    run: async () => { const n = await rebuildMintSimilarity(); log.info("similarity rebuilt", { n }); },
  },
  {
    name: "lead-stats",
    intervalMs: 6 * 3600_000,
    run: async () => { const n = await rebuildLeadStats(); log.info("lead stats rebuilt", { n }); },
  },
  {
    name: "pagerank",
    intervalMs: 12 * 3600_000,
    run: async () => { const n = await rebuildPageRank(0.85, 20, 2); log.info("pagerank rebuilt", { n }); },
  },
  {
    name: "ml-training",
    intervalMs: 24 * 3600_000,
    run: async () => {
      try {
        // Build before checking the threshold; otherwise a fresh installation can never bootstrap.
        const built = await q<{ build_training_data: number }>(`SELECT build_training_data(6, 12)`);
        const stats = await q<{ total: string }>(
          `SELECT COUNT(*)::text AS total FROM ml_feature_snapshots
           WHERE horizon_h = 6 AND label_basis = 'observed_dataset_views'
             AND label_views_growth_50 IS NOT NULL`
        );
        log.info("ml training data checked", { built: built[0]?.build_training_data ?? 0, total: Number(stats[0]?.total ?? 0) });
        if (Number(stats[0]?.total ?? 0) < 200) {
          log.info("ml training skipped — not enough data");
          return;
        }
        const m = await q<{ train_logistic_regression: string }>(
          `SELECT train_logistic_regression($1, 6, 0.01, 500, 0.001)`,
          [`auto-h6-${Date.now()}`]
        );
        log.info("ml model trained", { modelId: m[0]?.train_logistic_regression });
      } catch (e) {
        log.warn("ml training failed", { error: String(e) });
      }
    },
  },
];

async function tick(t: TaskDef) {
  if (runningTasks.has(t.name)) {
    log.warn("tick skipped — already running", { task: t.name });
    return;
  }
  runningTasks.add(t.name);
  const t0 = Date.now();
  try {
    log.info("tick start", { task: t.name });
    await t.run();
    log.info("tick done", { task: t.name, dur: Date.now() - t0 });
  } catch (e) {
    log.error("tick failed", { task: t.name, error: String(e) });
  } finally {
    runningTasks.delete(t.name);
  }
}

async function main() {
  log.info("scheduler started", { tasks: tasks.length });
  for (const t of tasks) {
    setTimeout(() => tick(t), 5000);
    setInterval(() => tick(t), t.intervalMs);
  }
}

main().catch((e) => {
  log.error("scheduler fatal", { error: String(e) });
  process.exit(1);
});

