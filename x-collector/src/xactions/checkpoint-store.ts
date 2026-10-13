import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { q1, tx } from "../../lib/trade/pg";

export type HttpSourceKind = "timeline" | "list" | "members" | "search";

export interface HttpCheckpointKey {
  taskId: number;
  sourceKind: HttpSourceKind;
  sourceKey: string;
  queryFingerprint: string;
}

export interface HttpCheckpointState {
  cursor: string | null;
  completed: boolean;
  pagesCommitted: number;
  itemsCommitted: number;
}

export interface HttpLease {
  workerId: string;
  attempt: number;
  accountName: string;
  accountOwner: string;
}

export interface HttpPageWrite extends HttpCheckpointKey {
  lease: HttpLease;
  expectedCursor: string | null;
  nextCursor: string | null;
  itemsWritten: number;
  completed: boolean;
}

interface CheckpointRow {
  query_fingerprint: string;
  cursor: string | null;
  completed: boolean;
  pages_committed: number;
  items_committed: string;
}

export function httpQueryFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function checkKey(key: HttpCheckpointKey): void {
  if (!Number.isSafeInteger(key.taskId) || key.taskId < 1) throw new Error("XActions: invalid task ID");
  if (key.sourceKey.length < 1 || key.sourceKey.length > 500) throw new Error("XActions: invalid source key");
  if (!/^[0-9a-f]{64}$/.test(key.queryFingerprint)) throw new Error("XActions: invalid query fingerprint");
}

export async function loadHttpCheckpoint(key: HttpCheckpointKey): Promise<HttpCheckpointState | null> {
  checkKey(key);
  const row = await q1<CheckpointRow>(
    `SELECT query_fingerprint, cursor, completed, pages_committed, items_committed
     FROM xc_http_checkpoints WHERE task_id=$1 AND source_kind=$2 AND source_key=$3`,
    [key.taskId, key.sourceKind, key.sourceKey],
  );
  if (!row) return null;
  if (row.query_fingerprint !== key.queryFingerprint) {
    throw new Error("XActions: checkpoint query changed; cannot resume");
  }
  return {
    cursor: row.cursor, completed: row.completed,
    pagesCommitted: row.pages_committed, itemsCommitted: Number(row.items_committed),
  };
}

/**
 * Atomically executes saveItems and advances the cursor.
 * saveItems MUST use the supplied PoolClient (never open its own transaction).
 * The existing collector store needs a shared-transaction entrypoint before this
 * function can be connected to a live worker.
 */
export async function commitHttpPage(
  write: HttpPageWrite,
  saveItems: (client: PoolClient) => Promise<void>,
): Promise<void> {
  await tx(client => writeHttpPageInTransaction(client, write, saveItems));
}

/**
 * Transaction body, exposed for local PGlite tests. A caller MUST hold a
 * database transaction; production always uses commitHttpPage above.
 */
export async function writeHttpPageInTransaction(
  client: PoolClient,
  write: HttpPageWrite,
  saveItems: (client: PoolClient) => Promise<void>,
): Promise<void> {
  checkKey(write);
  if (!Number.isSafeInteger(write.itemsWritten) || write.itemsWritten < 0) throw new Error("XActions: invalid page size");
  if (write.completed !== (write.nextCursor === null)) throw new Error("XActions: invalid terminal cursor");
  if (write.nextCursor !== null && (write.nextCursor.length < 1 || write.nextCursor.length > 8192)) {
    throw new Error("XActions: invalid next cursor");
  }

  {
    const checkLeases = async () => {
      const now = Date.now();
      const task = await client.query(
        `SELECT 1 FROM x_tasks WHERE id=$1 AND claimed_by=$2 AND attempts=$3
           AND status='claimed' AND lease_expires_at>$4 FOR UPDATE`,
        [write.taskId, write.lease.workerId, write.lease.attempt, now],
      );
      if (!task.rowCount) throw new Error("XActions: task lease lost");
      const account = await client.query(
        `SELECT 1 FROM x_accounts WHERE name=$1 AND account_claimed_by=$2
           AND account_busy_until>$3 FOR UPDATE`,
        [write.lease.accountName, write.lease.accountOwner, now],
      );
      if (!account.rowCount) throw new Error("XActions: account lease lost");
    };

    await checkLeases();
    const result = await client.query<CheckpointRow>(
      `SELECT query_fingerprint,cursor,completed,pages_committed,items_committed
       FROM xc_http_checkpoints
       WHERE task_id=$1 AND source_kind=$2 AND source_key=$3 FOR UPDATE`,
      [write.taskId, write.sourceKind, write.sourceKey],
    );
    const saved = result.rows[0];
    if (saved?.query_fingerprint && saved.query_fingerprint !== write.queryFingerprint) {
      throw new Error("XActions: checkpoint query changed");
    }
    if (saved?.completed) throw new Error("XActions: checkpoint is already complete");
    if ((saved?.cursor ?? null) !== write.expectedCursor) {
      throw new Error("XActions: stale checkpoint cursor; reload before retry");
    }
    if (write.nextCursor !== null && write.nextCursor === write.expectedCursor) {
      throw new Error("XActions: non-advancing checkpoint cursor");
    }

    await saveItems(client);
    await checkLeases();

    await client.query(
      `INSERT INTO xc_http_checkpoints
        (task_id,source_kind,source_key,query_fingerprint,cursor,completed,pages_committed,items_committed,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,1,$7,$8)
       ON CONFLICT(task_id,source_kind,source_key) DO UPDATE SET
         cursor=EXCLUDED.cursor,
         completed=EXCLUDED.completed,
         pages_committed=xc_http_checkpoints.pages_committed+1,
         items_committed=xc_http_checkpoints.items_committed+EXCLUDED.items_committed,
         updated_at=EXCLUDED.updated_at`,
      [write.taskId, write.sourceKind, write.sourceKey, write.queryFingerprint,
        write.nextCursor, write.completed, write.itemsWritten, Date.now()],
    );
  }
}
