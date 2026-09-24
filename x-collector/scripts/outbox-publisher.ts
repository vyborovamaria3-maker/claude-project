import { randomUUID } from "node:crypto";
import { q, closePool } from "../lib/trade/pg";
import { log } from "../lib/trade/logger";
import { notify } from "../lib/trade/notifications";

const workerId = `outbox-${randomUUID()}`;
const LEASE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 10;
let shuttingDown = false;
process.on("SIGINT", () => { shuttingDown = true; });
process.on("SIGTERM", () => { shuttingDown = true; });

async function dispatch(topic: string, payload: any) {
  switch (topic) {
    case "tweet.collected":
      // Extension point for enrichment and alerting; acknowledging is intentional until a consumer is added.
      return;
    case "mint.viral":
      await notify({ title: "🔥 Viral mint detected", body: JSON.stringify(payload) });
      return;
    default:
      throw new Error(`Unsupported outbox topic: ${topic}`);
  }
}

async function claimBatch() {
  const now = Date.now();
  await q(
    `UPDATE outbox
     SET failed_at=$1, claimed_at=NULL, claimed_by=NULL,
         last_error=COALESCE(last_error, 'max attempts exceeded before acknowledgement')
     WHERE published_at IS NULL AND failed_at IS NULL AND attempts >= $2
       AND (claimed_at IS NULL OR claimed_at <= $3)`,
    [now, MAX_ATTEMPTS, now - LEASE_MS]
  );
  return q<{ id: string; topic: string; payload: any; attempts: number }>(
    `WITH picked AS (
       SELECT id FROM outbox
       WHERE published_at IS NULL AND failed_at IS NULL
         AND available_at <= $1
         AND (claimed_at IS NULL OR claimed_at <= $2)
         AND attempts < $3
       ORDER BY created_at ASC, id ASC
       LIMIT 10
       FOR UPDATE SKIP LOCKED
     )
     UPDATE outbox o
     SET claimed_at=$1, claimed_by=$4, attempts=o.attempts+1
     FROM picked
     WHERE o.id=picked.id
     RETURNING o.id::text, o.topic, o.payload, o.attempts`,
    [now, now - LEASE_MS, MAX_ATTEMPTS, workerId]
  );
}

async function acknowledge(id: string) {
  await q(
    `UPDATE outbox
     SET published_at=$1, claimed_at=NULL, claimed_by=NULL, last_error=NULL
     WHERE id=$2 AND claimed_by=$3 AND published_at IS NULL`,
    [Date.now(), id, workerId]
  );
}

async function recordFailure(id: string, attempts: number, error: unknown) {
  const now = Date.now();
  const retryDelay = Math.min(5 * 60_000, 1000 * (2 ** Math.min(attempts, 8)));
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  await q(
    `UPDATE outbox
     SET last_error=$1, claimed_at=NULL, claimed_by=NULL,
         available_at=CASE WHEN attempts >= $2 THEN available_at ELSE $3 END,
         failed_at=CASE WHEN attempts >= $2 THEN $4 ELSE NULL END
     WHERE id=$5 AND claimed_by=$6 AND published_at IS NULL`,
    [message, MAX_ATTEMPTS, now + retryDelay, now, id, workerId]
  );
}

async function loop() {
  log.info("outbox publisher started", { workerId });
  try {
    while (!shuttingDown) {
      try {
        const rows = await claimBatch();
        for (const row of rows) {
          try {
            await dispatch(row.topic, row.payload);
            await acknowledge(row.id);
          } catch (e) {
            await recordFailure(row.id, row.attempts, e);
            if (row.attempts >= MAX_ATTEMPTS) {
              log.error("outbox message dead-lettered", { id: row.id, topic: row.topic, error: String(e) });
            } else {
              log.warn("outbox dispatch failed; will retry", { id: row.id, topic: row.topic, attempt: row.attempts, error: String(e) });
            }
          }
        }
        if (rows.length === 0) await new Promise((r) => setTimeout(r, 1000));
      } catch (e) {
        log.error("outbox loop error", { error: String(e) });
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  } finally {
    log.info("outbox publisher stopped");
    await closePool().catch(() => {});
  }
}

loop().catch(async (e) => {
  log.error("outbox publisher fatal", { error: String(e) });
  await closePool().catch(() => {});
  process.exitCode = 1;
});
