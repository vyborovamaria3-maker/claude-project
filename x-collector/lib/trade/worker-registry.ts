import os from "node:os";
import { exec, q, q1, tx } from "./pg";
import { log } from "./logger";

export class WorkerRegistry {
  private doneBuffer = 0;
  private failedBuffer = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private hbTimer: NodeJS.Timeout | null = null;

  constructor(public readonly id: string, private heartbeatMs = 30_000) {}

  async register() {
    const now = Date.now();
    await exec(
      `INSERT INTO x_workers (id, pid, host, started_at, last_heartbeat, status)
       VALUES ($1,$2,$3,$4,$4,'active')
       ON CONFLICT(id) DO UPDATE SET
         pid=EXCLUDED.pid, host=EXCLUDED.host,
         started_at=EXCLUDED.started_at, last_heartbeat=EXCLUDED.last_heartbeat,
         status='active'`,
      [this.id, process.pid, os.hostname(), now]
    );
  }

  start() {
    this.hbTimer = setInterval(() => {
      exec(`UPDATE x_workers SET last_heartbeat=$1, status='active' WHERE id=$2`,
        [Date.now(), this.id]).catch((e) => log.warn("heartbeat failed", { workerId: this.id, error: String(e) }));
    }, this.heartbeatMs);
    this.flushTimer = setInterval(() => {
      this.flush().catch((e) => log.warn("flush failed", { workerId: this.id, error: String(e) }));
    }, 30_000);
  }

  private async flush() {
    if (this.doneBuffer === 0 && this.failedBuffer === 0) return;
    const d = this.doneBuffer, f = this.failedBuffer;
    this.doneBuffer = 0; this.failedBuffer = 0;
    await exec(
      `UPDATE x_workers SET tasks_done=tasks_done+$1, tasks_failed=tasks_failed+$2 WHERE id=$3`,
      [d, f, this.id]
    );
  }

  incrementDone() { this.doneBuffer++; }
  incrementFailed() { this.failedBuffer++; }

  async stop() {
    if (this.hbTimer) clearInterval(this.hbTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush().catch(() => {});
    await exec(`UPDATE x_workers SET status='stopped' WHERE id=$1`, [this.id]).catch(() => {});
  }
}

export async function reapDeadWorkers(timeoutMs = 5 * 60_000) {
  const cutoff = Date.now() - timeoutMs;
  const now = Date.now();
  await tx(async (c) => {
    await c.query(`UPDATE x_workers SET status='dead' WHERE status='active' AND last_heartbeat < $1`, [cutoff]);
    await c.query(
      `UPDATE x_tasks
       SET lease_expires_at = LEAST(COALESCE(lease_expires_at, $1), $1),
           last_error = COALESCE(last_error,'') || ' [worker died]', updated_at=$1
       WHERE status='claimed' AND claimed_by IN (SELECT id FROM x_workers WHERE status='dead')
         AND (lease_expires_at IS NULL OR lease_expires_at > $1)`,
      [now]
    );
  });
}

export interface WorkerRow {
  id: string; pid: number | null; host: string | null; status: string;
  stale_sec: string; tasks_done: string; tasks_failed: string;
}

export async function listWorkers(): Promise<WorkerRow[]> {
  return q<WorkerRow>(
    `SELECT id, pid, host, status,
            (EXTRACT(EPOCH FROM NOW())*1000 - last_heartbeat)/1000 AS stale_sec,
            tasks_done, tasks_failed
     FROM x_workers ORDER BY last_heartbeat DESC`
  );
}

export async function activeWorkerCount(): Promise<number> {
  const r = await q1<{ n: number }>(`SELECT COUNT(*)::int AS n FROM x_workers WHERE status='active'`);
  return r?.n ?? 0;
}

