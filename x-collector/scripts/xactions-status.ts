import { q, q1, closePool } from "../lib/trade/pg";

interface TaskRow {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  max_attempts: number;
}
interface CheckpointRow {
  source_kind: string;
  source_key: string;
  pages_committed: number;
  items_committed: string;
  completed: boolean;
  has_cursor: boolean;
  updated_at: string;
}

/** Local read-only status query; deliberately never prints opaque HTTP cursors. */
async function main(): Promise<void> {
  const raw = process.argv[2];
  const taskId = Number(raw);
  if (!raw || !Number.isSafeInteger(taskId) || taskId < 1) {
    throw new Error("Usage: npm run xactions:status -- <positive_task_id>");
  }
  const task = await q1<TaskRow>(
    `SELECT id::text,kind,status,attempts,max_attempts FROM x_tasks WHERE id=$1`,
    [taskId],
  );
  if (!task) throw new Error("XActions: task ID not found");
  const states = await q<CheckpointRow>(
    `SELECT source_kind,source_key,pages_committed,items_committed::text,completed,
       (cursor IS NOT NULL) AS has_cursor,updated_at::text
     FROM xc_http_checkpoints WHERE task_id=$1
     ORDER BY source_kind,source_key`,
    [taskId],
  );
  const hasIncompleteProgress = states.some(p => !p.completed && p.pages_committed > 0);
  const collectionState = task.status === "done" ? "completed"
    : task.status === "failed" ? "failed"
    : hasIncompleteProgress ? "partial"
    : task.status === "claimed" ? "running" : "waiting";
  console.log(JSON.stringify({
    task,
    collectionState,
    checkpoints: states.map(p => ({
      sourceKind: p.source_kind,
      sourceKey: p.source_key,
      pagesCommitted: p.pages_committed,
      uniqueItemsCommitted: Number(p.items_committed),
      completed: p.completed,
      hasResumeCursor: p.has_cursor,
      updatedAt: new Date(Number(p.updated_at)).toISOString(),
    })),
  }, null, 2));
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : "Cannot read HTTP task status");
  process.exitCode = 1;
}).finally(() => closePool());
