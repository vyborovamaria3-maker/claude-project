import { q } from "../../../lib/trade/pg";
import { deriveTaskDisplayState, safeLastErrorCode } from "../queue/task-status";

interface ActiveTaskRow {
  id: string; kind: string; status: string; attempts: number; max_attempts: number;
  available_at: string; phase: string | null; last_error: string | null; partial: boolean;
}

/** Read-only local dashboard query. Does not expose query text or account credentials. */
export async function activeTaskSnapshot(now = Date.now(), limit = 50) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("Invalid dashboard task limit");
  const rows = await q<ActiveTaskRow>(
    `SELECT t.id::text AS id,t.kind,t.status,t.attempts,t.max_attempts,
       t.available_at::text AS available_at,t.last_error,p.phase,
       (EXISTS(SELECT 1 FROM x_task_tweets tt WHERE tt.task_id=t.id) OR
        EXISTS(SELECT 1 FROM xc_http_checkpoints cp
          WHERE cp.task_id=t.id AND cp.pages_committed>0 AND NOT cp.completed)) AS partial
     FROM x_tasks t LEFT JOIN x_task_progress p ON p.task_id=t.id
     WHERE t.status IN ('pending','claimed')
     ORDER BY CASE t.status WHEN 'claimed' THEN 0 ELSE 1 END,
              t.available_at ASC,t.id ASC LIMIT $1`,
    [limit],
  );
  return rows.map(row => ({
    id: row.id,
    kind: row.kind,
    state: deriveTaskDisplayState({
      status: row.status, now, availableAt: Number(row.available_at),
      phase: row.phase, lastError: row.last_error, hasPartialCheckpoint: row.partial,
    }),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextEligibleInSeconds: Math.max(0, Math.ceil((Number(row.available_at) - now) / 1000)),
    lastErrorCode: safeLastErrorCode(row.last_error),
    persistedPartialOutput: row.partial,
  }));
}
