import { createHash } from "node:crypto";
import { q, q1, tx } from "./pg";

export type TaskKind = "search" | "timeline" | "profile";
export type TaskStatus = "pending" | "claimed" | "done" | "failed";

export interface ClaimedTask {
  id: number; kind: TaskKind; payloadJson: string;
  mint: string | null; handle: string | null;
  attempts: number; maxAttempts: number; claimedBy: string;
}

function idempotencyKey(kind: string, params: Record<string, unknown>): string {
  const sorted = Object.keys(params).sort().reduce((acc, k) => { acc[k] = params[k]; return acc; }, {} as Record<string, unknown>);
  return createHash("sha256").update(`${kind}:${JSON.stringify(sorted)}`).digest("hex").slice(0, 40);
}

export interface EnqueueParams {
  kind: TaskKind;
  payload: Record<string, unknown>;
  mint?: string | null;
  handle?: string | null;
  priority?: number;
  delayMs?: number;
  dedup?: boolean;
  idempotencyKey?: string;
}

export async function enqueueTask(p: EnqueueParams): Promise<number | null> {
  const now = Date.now();
  const key = p.dedup === false ? null
    : (p.idempotencyKey ?? idempotencyKey(p.kind, { mint: p.mint, handle: p.handle, ...p.payload }));
  const availableAt = now + (p.delayMs ?? 0);

  const row = await q1<{ id: number }>(
    `INSERT INTO x_tasks
       (kind, payload_json, mint, handle, priority, available_at, created_at, updated_at, idempotency_key)
     VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $7, $8)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [p.kind, JSON.stringify(p.payload), p.mint ?? null,
     p.handle?.toLowerCase() ?? null, p.priority ?? 0, availableAt, now, key]
  );
  return row?.id ?? null;
}

export async function claimTasks(workerId: string, limit: number, leaseMs: number): Promise<ClaimedTask[]> {
  const now = Date.now();
  return tx(async (c) => {
    const expired = await c.query<{
      id: number; kind: string; payload_json: any; mint: string | null;
      handle: string | null; attempts: number; last_error: string | null; exhausted: boolean;
    }>(
      `UPDATE x_tasks
       SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
           claimed_by=NULL, claimed_at=NULL, lease_expires_at=NULL,
           available_at = CASE WHEN attempts >= max_attempts THEN available_at ELSE $1 END,
           last_error = COALESCE(last_error,'') || ' [lease expired]', updated_at=$1
       WHERE status='claimed' AND (
         (lease_expires_at IS NOT NULL AND lease_expires_at < $1) OR
         (lease_expires_at IS NULL AND (claimed_at IS NULL OR claimed_at < $1 - 300000))
       )
       RETURNING id, kind, payload_json, mint, handle, attempts, last_error,
                 (attempts >= max_attempts) AS exhausted`,
      [now]
    );
    for (const t of expired.rows) {
      if (!t.exhausted) continue;
      await c.query(
        `INSERT INTO x_tasks_dlq
           (original_id, kind, payload_json, mint, handle, attempts, last_error, failed_at)
         VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8)`,
        [t.id, t.kind, JSON.stringify(t.payload_json), t.mint, t.handle,
         t.attempts, t.last_error ?? 'lease expired', now]
      );
    }
    const r = await c.query<ClaimedTask>(
      `UPDATE x_tasks
       SET status='claimed', claimed_by=$1, claimed_at=$2, lease_expires_at=$3,
           attempts=attempts+1, updated_at=$2
       WHERE id IN (
         SELECT id FROM x_tasks
         WHERE status='pending' AND available_at <= $2 AND attempts < max_attempts
         ORDER BY priority DESC, available_at ASC, id ASC
         LIMIT $4
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, kind, payload_json::text AS "payloadJson", mint, handle,
                 attempts, max_attempts AS "maxAttempts", claimed_by AS "claimedBy"`,
      [workerId, now, now + leaseMs, limit]
    );
    return r.rows;
  });
}

export async function extendLease(taskId: number, workerId: string, extraMs: number): Promise<boolean> {
  const now = Date.now();
  const r = await tx((c) => c.query(
    `UPDATE x_tasks SET lease_expires_at=$1, updated_at=$2
     WHERE id=$3 AND claimed_by=$4 AND status='claimed'`,
    [now + extraMs, now, taskId, workerId]
  ));
  return (r.rowCount ?? 0) > 0;
}

export async function finishTask(taskId: number, workerId: string): Promise<boolean> {
  const r = await tx((c) => c.query(
    `UPDATE x_tasks
     SET status='done', claimed_by=NULL, claimed_at=NULL, lease_expires_at=NULL, updated_at=$1
     WHERE id=$2 AND claimed_by=$3 AND status='claimed'`,
    [Date.now(), taskId, workerId]
  ));
  return (r.rowCount ?? 0) > 0;
}

export async function failTask(
  taskId: number, workerId: string, error: string
): Promise<"requeued" | "dlq" | "lost"> {
  const now = Date.now();
  return tx(async (c) => {
    const r = await c.query<{
      attempts: number; max_attempts: number; kind: string;
      payload_json: any; mint: string | null; handle: string | null; should_dlq: boolean;
    }>(
      `UPDATE x_tasks
       SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
           claimed_by=NULL, claimed_at=NULL, lease_expires_at=NULL,
           available_at = CASE WHEN attempts >= max_attempts THEN available_at ELSE $1 + 60000 END,
           last_error=$2, updated_at=$1
       WHERE id=$3 AND claimed_by=$4 AND status='claimed'
       RETURNING attempts, max_attempts, kind, payload_json, mint, handle,
                 (attempts >= max_attempts) AS should_dlq`,
      [now, error.slice(0, 1000), taskId, workerId]
    );
    const t = r.rows[0];
    if (!t) return "lost";
    if (t.should_dlq) {
      await c.query(
        `INSERT INTO x_tasks_dlq
           (original_id, kind, payload_json, mint, handle, attempts, last_error, failed_at)
         VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8)`,
        [taskId, t.kind, JSON.stringify(t.payload_json), t.mint, t.handle, t.attempts, error.slice(0, 1000), now]
      );
      return "dlq";
    }
    return "requeued";
  });
}

export async function deferTask(
  taskId: number, workerId: string, delayMs = 60_000, reason = "deferred"
): Promise<boolean> {
  const now = Date.now();
  const r = await tx((c) => c.query(
    `UPDATE x_tasks
     SET status='pending', attempts=GREATEST(attempts - 1, 0),
         claimed_by=NULL, claimed_at=NULL, lease_expires_at=NULL,
         available_at=$1 + $2, last_error=$3, updated_at=$1
     WHERE id=$4 AND claimed_by=$5 AND status='claimed'`,
    [now, delayMs, reason.slice(0, 1000), taskId, workerId]
  ));
  return (r.rowCount ?? 0) > 0;
}

export async function queueStats() {
  return q<{ status: string; kind: string; n: number }>(
    `SELECT status, kind, COUNT(*)::int AS n FROM x_tasks GROUP BY status, kind ORDER BY status, kind`
  );
}

export async function dlqStats() {
  return q1<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM x_tasks_dlq WHERE reviewed_at IS NULL`
  );
}

