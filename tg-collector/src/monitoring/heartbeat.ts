import { pool } from "../db.js";

/** Heartbeats continue while Telegram requests or database batches are in flight. */
export async function startHeartbeat(): Promise<() => Promise<void>> {
  await pool.query("UPDATE tg_runtime SET worker_started_at=now(),heartbeat_at=now() WHERE id=1");
  const timer = setInterval(() => {
    void pool.query("UPDATE tg_runtime SET heartbeat_at=now() WHERE id=1")
      .catch(error => console.error("TG heartbeat failed:", String(error)));
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
