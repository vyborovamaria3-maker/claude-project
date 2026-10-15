import { q, closePool } from "../lib/trade/pg";
import { activeTaskSnapshot } from "../lib/trade/task-dashboard";
import { safeLastErrorCode } from "../lib/trade/task-status";

interface TaskErrorRow { status: string; kind: string; code: string; tasks: number; }
interface AccountErrorRow { type: string; events: number; }
interface CountRow { status: string; count: number; }

/**
 * PostgreSQL groups historical error tags before returning them; collapse
 * unknown tags into one safe bucket and combine their counts in JS.
 */
export function collapseErrorTags(rows:TaskErrorRow[]):TaskErrorRow[] {
  const grouped = new Map<string,TaskErrorRow>();
  for (const row of rows) {
    const code = safeLastErrorCode("[" + row.code + "]") ?? "LEGACY_OR_UNKNOWN";
    const key = JSON.stringify([row.status,row.kind,code]);
    const previous = grouped.get(key);
    if (previous) previous.tasks += Number(row.tasks);
    else grouped.set(key,{status:row.status,kind:row.kind,code,tasks:Number(row.tasks)});
  }
  return [...grouped.values()].sort((a,b)=>b.tasks-a.tasks || a.code.localeCompare(b.code));
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
  return { windowHours: Math.round(windowMs / 3_600_000), taskErrorSnapshot: collapseErrorTags(taskErrors), accountErrorEvents: accountErrors };
}

async function main(): Promise<void> {
  const now = Date.now();
  const [oneHour, day, queue, accounts, active] = await Promise.all([
    collect(3_600_000, now), collect(86_400_000, now),
    q<CountRow>("SELECT status,count(*)::int AS count FROM x_tasks GROUP BY status ORDER BY status"),
    q<CountRow>("SELECT status,count(*)::int AS count FROM x_accounts WHERE role='collector' GROUP BY status ORDER BY status"),
    activeTaskSnapshot(now),
  ]);
  console.log(JSON.stringify({
    observedAt: new Date(now).toISOString(),
    queue,
    collectorAccounts: accounts,
    activeTasksSample: active,
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
