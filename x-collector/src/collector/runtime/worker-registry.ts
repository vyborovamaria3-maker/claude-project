import os from "node:os";
import { exec, q, q1, tx } from "../../../lib/trade/pg";
import { log } from "../../../lib/trade/logger";

export class WorkerRegistry {
  private doneBuffer = 0;
  private failedBuffer = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private hbTimer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private heartbeat: Promise<unknown> | null = null;

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
    if (this.hbTimer || this.flushTimer) return;
    this.hbTimer = setInterval(() => {
      if (this.heartbeat) return;
      this.heartbeat = exec(`UPDATE x_workers SET last_heartbeat=$1, status='active' WHERE id=$2`,
        [Date.now(), this.id]).catch((e) => log.warn("heartbeat failed", { workerId: this.id, error: String(e) }))
        .finally(() => { this.heartbeat = null; });
    }, this.heartbeatMs);
    this.flushTimer = setInterval(() => {
      this.flush().catch((e) => log.warn("flush failed", { workerId: this.id, error: String(e) }));
    }, 30_000);
  }

  private async flush() {
    if (this.flushing) return this.flushing;
    if (this.doneBuffer === 0 && this.failedBuffer === 0) return;
    const d = this.doneBuffer, f = this.failedBuffer;
    this.doneBuffer = 0; this.failedBuffer = 0;
    this.flushing = exec(
      `UPDATE x_workers SET tasks_done=tasks_done+$1, tasks_failed=tasks_failed+$2 WHERE id=$3`,
      [d, f, this.id]
    ).then(() => {}).catch(error => {
      this.doneBuffer += d; this.failedBuffer += f;
      throw error;
    }).finally(() => { this.flushing = null; });
    return this.flushing;
  }

  incrementDone() { this.doneBuffer++; }
  incrementFailed() { this.failedBuffer++; }

  async stop() {
    if (this.hbTimer) clearInterval(this.hbTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.hbTimer = null; this.flushTimer = null;
    await this.heartbeat;
    await this.flushing?.catch(() => {});
    await this.flush().catch(() => {});
    await exec(`UPDATE x_workers SET status='stopped' WHERE id=$1`, [this.id]).catch(() => {});
  }
}

export async function reapDeadWorkers(timeoutMs = 5 * 60_000) {
  const cutoff = Date.now() - timeoutMs;
  await tx(async (c) => {
    await c.query(`UPDATE x_workers SET status='dead' WHERE status='active' AND last_heartbeat < $1`, [cutoff]);
    // A stale heartbeat is diagnostic only; claimTasks recovers expired task leases.
  });
}

export interface WorkerRow {
  id: string; pid: number | null; host: string | null; status: string;
  stale_sec: string; tasks_done: string; tasks_failed: string;
  lifecycle: string; current_job: unknown;
}

export async function listWorkers(): Promise<WorkerRow[]> {
  return q<WorkerRow>(
    `SELECT w.id, w.pid, w.host, w.status,
            (EXTRACT(EPOCH FROM NOW())*1000 - w.last_heartbeat)/1000 AS stale_sec,
            w.tasks_done, w.tasks_failed,
            CASE WHEN w.status='stopped' THEN 'STOPPED'
              WHEN w.last_heartbeat < EXTRACT(EPOCH FROM NOW())*1000-90000 THEN 'STALE'
              WHEN j.id IS NOT NULL THEN 'RUNNING' ELSE 'READY' END AS lifecycle,
            CASE WHEN j.id IS NOT NULL THEN jsonb_build_object('id',j.id,'kind',j.kind,'attempt',j.attempts) END AS current_job
     FROM x_workers w LEFT JOIN LATERAL (
       SELECT id,kind,attempts FROM x_tasks WHERE claimed_by=w.id AND status='claimed'
         AND lease_expires_at > EXTRACT(EPOCH FROM NOW())*1000 ORDER BY claimed_at DESC LIMIT 1
     ) j ON true ORDER BY w.last_heartbeat DESC`
  );
}

export async function activeWorkerCount(): Promise<number> {
  const r = await q1<{ n: number }>(`SELECT COUNT(*)::int AS n FROM x_workers WHERE status='active' AND last_heartbeat>$1`, [Date.now()-90000]);
  return r?.n ?? 0;
}

