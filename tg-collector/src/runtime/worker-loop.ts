import "dotenv/config";
import { discoverPublicSources } from "./discovery.js";
import { setTimeout as sleep } from "node:timers/promises";
import { pool, migrate } from "../db.js";
import { authorizedClient } from "../accounts/session.js";
import { claim, handleFailure } from "../queue/jobs.js";
import { processJob } from "../engines/channel.js";
import { startHeartbeat, remainingPauseSeconds } from "../monitoring/heartbeat.js";
import type { TelegramClient } from "telegram";
import { classifyTelegramError } from "../queue/retry.js";

let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

async function main(): Promise<void> {
  await migrate();
  const guard = await pool.connect();
  // Losing this connection releases the singleton lock. Exit immediately so a
  // replacement worker cannot race with this process persisting an in-flight page.
  guard.on("error", () => {
    console.error("TG worker lock connection lost; terminating");
    process.exit(1);
  });
  let client: TelegramClient | undefined;
  let stopHeartbeat: (() => Promise<void>) | undefined;
  try {
    const { rows } = await guard.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(8260226) AS acquired"
    );
    if (!rows[0]?.acquired) throw new Error("Another TG Collector worker is already running");
    // The singleton lock proves an old worker can no longer own a job lease.
    await pool.query("UPDATE tg_jobs SET state='pending', locked_until=NULL WHERE state='running'");
    await pool.query("UPDATE tg_runtime SET worker_version=$1,worker_started_at=now(),last_error_code=NULL WHERE id=1",
      [process.env.npm_package_version ?? "0.1.0"]);
    const state = await pool.query<{ block_reason: string | null }>(
      "SELECT block_reason FROM tg_runtime WHERE id=1");
    if (state.rows[0]?.block_reason) throw new Error("TG_COLLECTOR_BLOCKED: " + state.rows[0].block_reason);
    try {
      client = await authorizedClient();
    } catch (error) {
      const classification = classifyTelegramError(error, 0);
      if (classification.action === "halt")
        await pool.query("UPDATE tg_runtime SET block_reason=$1,blocked_at=now() WHERE id=1", [classification.code]);
      throw error;
    }
    stopHeartbeat = await startHeartbeat();
    console.log("TG Collector worker started");
    while (!stopping) {
      const runtime = await pool.query<{collection_enabled: boolean}>(
        "SELECT collection_enabled FROM tg_runtime WHERE id=1"
      );
      if (runtime.rows[0]?.collection_enabled === false) {
        await sleep(3000);
        continue;
      }
      const seconds = await remainingPauseSeconds();
      if (seconds > 0) { await sleep(Math.min(seconds * 1000, 5000)); continue; }
      if ((await discoverPublicSources(client, () => stopping)) === "halt") {
        stopping = true; process.exitCode = 1; continue;
      }
      const job = await claim();
      if (!job) { await sleep(3000); continue; }
      try { await processJob(client, job, () => stopping); }
      catch (error) {
        if ((await handleFailure(job, error)) === "halt") {
          stopping = true;
          process.exitCode = 1;
        }
      }
    }
  } finally {
    if (client) await client.disconnect().catch(() => {});
    if (stopHeartbeat) await stopHeartbeat().catch(() => {});
    try { await guard.query("SELECT pg_advisory_unlock(8260226)"); }
    finally { guard.release(); await pool.end(); }
  }
}
main().catch(error => {
  console.error("Worker fatal:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
