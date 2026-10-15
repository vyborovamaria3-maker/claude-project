import "dotenv/config";
import { setTimeout as sleep } from "node:timers/promises";
import { pool, migrate } from "../db.js";
import { authorizedClient } from "../accounts/session.js";
import { claim, handleFailure } from "../queue/jobs.js";
import { processJob } from "../engines/channel.js";
import { startHeartbeat, remainingPauseSeconds } from "../monitoring/heartbeat.js";
import type { TelegramClient } from "telegram";

let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

async function main(): Promise<void> {
  await migrate();
  const guard = await pool.connect();
  let client: TelegramClient | undefined;
  let stopHeartbeat: (() => Promise<void>) | undefined;
  try {
    const { rows } = await guard.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(8260226) AS acquired"
    );
    if (!rows[0]?.acquired) throw new Error("Another TG Collector worker is already running");
    // The singleton lock proves an old worker can no longer own a job lease.
    await pool.query("UPDATE tg_jobs SET state='pending', locked_until=NULL WHERE state='running'");
    client = await authorizedClient();
    stopHeartbeat = await startHeartbeat();
    console.log("TG Collector worker started");
    while (!stopping) {
      const seconds = await remainingPauseSeconds();
      if (seconds > 0) { await sleep(Math.min(seconds * 1000, 5000)); continue; }
      const job = await claim();
      if (!job) { await sleep(3000); continue; }
      try { await processJob(client, job, () => stopping); }
      catch (error) { await handleFailure(job, error); }
    }
  } finally {
    if (client) await client.disconnect();
    if (stopHeartbeat) await stopHeartbeat().catch(() => {});
    try { await guard.query("SELECT pg_advisory_unlock(8260226)"); }
    finally { guard.release(); await pool.end(); }
  }
}
main().catch(error => {
  console.error("Worker fatal:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
