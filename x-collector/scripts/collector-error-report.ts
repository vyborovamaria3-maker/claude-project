import { q, closePool } from "../lib/trade/pg";
import { deriveTaskDisplayState, safeLastErrorCode } from "../lib/trade/task-status";

interface TaskErrorRow { status: string; kind: string; code: string; tasks: number; }
interface AccountErrorRow { type: string; events: number; }
interface CountRow { status: string; count: number; }
interface ActiveTaskRow {
  id: string; kind: string; status: string; attempts: number; max_attempts: number;
  available_at: string; phase: string | null; last_error: string | null; partial: boolean;
}

/** Read-only, account/credential-free failure snapshots for a local laptop. */
async function collect(windowMs: number, now: number) {
  const since = now - windowMs;
  const [taskErrors, accountErrors] = await Promise.all([
    q<TaskErrorRow>(
      `SELECT status, kind,
        CASE WHEN left(last_error,1)='[' AND strpos(last_error,']')>1
          THEN substring(last_error from 2 for strpos(last_error,']')-2)
          ELSE 'LEGACY_OR_UNKNOWN' END AS code,
        count(*)::int AS tasks
       FROM x_tasks WHERE last_error IS NOT NULL AND updated_at >= $1
       GROUP BY status, kind, code ORDER BY tasks DESC,code ASC`,
      [since],
    ),
    q<AccountErrorRow>(
      `SELECT type, count(*)::int AS events FROM xc_account_errors
       WHERE created_at >= $1 GROUP BY type ORDER BY events DESC,type ASC`,
      [since],
    ),
  ]);
  return { windowHours: Math.round(windowMs / 3_600_000), taskErrorSnapshot: taskErrors, accountErrorEvents: accountErrors };
}

async function main(): Promise<void> {
  const now = Date.now();
  const [oneHour, day, queue, accounts, active] = await Promise.all([
    collect(3_600_000, now), collect(86_400_000, now),
    q<CountRow>("SELECT status,count(*)::int AS count FROM x_tasks GROUP BY status ORDER BY status"),
    q<CountRow>("SELECT status,count(*)::int AS count FROM x_accounts WHERE role='collector' GROUP BY status ORDER BY status"),
    q<ActiveTaskRow>(
      `SELECT t.id::text AS id,t.kind,t.status,t.attempts,t.max_attempts,
         t.available_at::text AS available_at,t.last_error,p.phase,
         (EXISTS(SELECT 1 FROM x_task_tweets tt WHERE tt.task_id=t.id) OR
          EXISTS(SELECT 1 FROM xc_http_checkpoints cp
            WHERE cp.task_id=t.id AND cp.pages_committed>0 AND NOT cp.completed)) AS partial
       FROM x_tasks t LEFT JOIN x_task_progress p ON p.task_id=t.id
       WHERE t.status IN ('pending','claimed')
       ORDER BY CASE t.status WHEN 'claimed' THEN 0 ELSE 1 END,
                t.available_at ASC,t.id ASC LIMIT 50`,
    ),
  ]);
  console.log(JSON.stringify({
    observedAt: new Date(now).toISOString(),
    queue,
    collectorAccounts: accounts,
    activeTasksSample: active.map(row => ({
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
    })),
    windows: [oneHour, day],
    notes: [
      "Task errors are snapshots of latest error per task, not a count of every error event.",
      "Account errors are timestamped events. One task may appear in both windows.",
      "Historical failures are not proof of current failures; no tokens, URLs or proxy secrets are printed.",
      "Active tasks sample is at most 50 rows; states are derived for display, not an SQL status migration.",
    ],
  }, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "Collector report failed");
  process.exitCode = 1;
}).finally(() => closePool());
