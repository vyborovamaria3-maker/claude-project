import { pool } from "../db.js";

export type RuntimeMetrics = {
  messages_total: number;
  messages_per_day: number;
  links_total: number;
  links_per_day: number;
  jobs_pending: number;
  jobs_failed: number;
  flood_wait_active: boolean;
};

async function refreshRuntimeMetrics(): Promise<void> {
  await pool.query(`
    UPDATE tg_runtime
    SET messages_total = COALESCE((SELECT sum(message_count) FROM tg_source_message_counters),0),
        messages_per_day = COALESCE((
          SELECT sum(posts_count) FROM tg_source_daily_metrics
          WHERE day = (now() AT TIME ZONE 'UTC')::date
        ),0),
        links_total = COALESCE((SELECT links_total FROM tg_runtime_metrics WHERE id=1),0),
        links_per_day = COALESCE((
          SELECT sum(evidence_count) FROM tg_graph_daily_edges
          WHERE day = (now() AT TIME ZONE 'UTC')::date
        ),0),
        jobs_pending = COALESCE((
          SELECT count(*) FROM tg_jobs
          WHERE state IN ('pending','delayed')
        ),0),
        jobs_failed = COALESCE((
          SELECT count(*) FROM tg_jobs WHERE state='failed'
        ),0),
        flood_wait_active = COALESCE(
          pause_until IS NOT NULL AND pause_until > now(), FALSE
        ),
        metrics_updated_at = now()
    WHERE id=1
  `);
}

/** Heartbeat and growth metrics are updated independently from Telegram request latency. */
export async function startHeartbeat(): Promise<() => Promise<void>> {
  await pool.query("UPDATE tg_runtime SET worker_started_at=now(),heartbeat_at=now() WHERE id=1");
  await refreshRuntimeMetrics();
  const timer = setInterval(() => {
    void Promise.all([
      pool.query("UPDATE tg_runtime SET heartbeat_at=now() WHERE id=1"),
      refreshRuntimeMetrics(),
    ]).catch(error => console.error("TG heartbeat failed:", String(error)));
  }, 5000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await pool.query("UPDATE tg_runtime SET heartbeat_at=NULL WHERE id=1");
  };
}

export async function remainingPauseSeconds(): Promise<number> {
  const { rows } = await pool.query<{ wait_seconds: number }>(
    "SELECT GREATEST(0,EXTRACT(EPOCH FROM (pause_until-now())))::float8 AS wait_seconds FROM tg_runtime WHERE id=1"
  );
  return Number(rows[0]?.wait_seconds ?? 0);
}
