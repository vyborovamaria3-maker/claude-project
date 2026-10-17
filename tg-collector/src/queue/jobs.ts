import { pool } from "../db.js";
import { classifyTelegramError } from "./retry.js";
import { pollSeconds } from "../runtime/config.js";
export type Job = {
  id: string; source_id: string; attempts: number;
  base_message_id: string | null; high_message_id: string | null;
  cursor_before_id: string | null; scanned_count: number;
};

export async function claim(): Promise<Job | undefined> {
  const { rows } = await pool.query<Job>(`
    WITH pick AS (
      SELECT j.id FROM tg_jobs j JOIN tg_sources s ON s.id=j.source_id
      WHERE s.enabled AND EXISTS (SELECT 1 FROM tg_runtime WHERE id=1 AND collection_enabled
        AND block_reason IS NULL AND (pause_until IS NULL OR pause_until <= now()))
        AND ((j.state IN ('pending','delayed') AND j.run_at <= now())
         OR (j.state='running' AND j.locked_until < now()))
      ORDER BY j.run_at, j.id
      FOR UPDATE OF j SKIP LOCKED LIMIT 1
    )
    UPDATE tg_jobs j SET state='running', attempts=attempts+1,
           locked_until=now()+interval '15 minutes', updated_at=now()
    FROM pick WHERE j.id=pick.id
    RETURNING j.*`);
  return rows[0];
}


export async function finishJob(job: Job, highId: number, partial: boolean): Promise<void> {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    await tx.query(
      `UPDATE tg_sources SET last_message_id=GREATEST(last_message_id,$2),
        history_partial=history_partial OR $3, last_success_at=now()
        WHERE id=$1`, [job.source_id, highId, partial]
    );
    await tx.query(`UPDATE tg_jobs SET state='pending', attempts=0,
      base_message_id=NULL, high_message_id=NULL, cursor_before_id=NULL,
      scanned_count=0, run_at=now()+($2::int * interval '1 second'),
      locked_until=NULL, last_error=NULL, updated_at=now() WHERE id=$1`,
      [job.id, pollSeconds]);
    await tx.query("COMMIT");
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally { tx.release(); }
}


/** Account/session level errors halt the worker. No automatic account rotation. */
export async function handleFailure(job: Job, error: unknown): Promise<"halt" | "continue"> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0,300);
  const decision = classifyTelegramError(error, job.attempts);
  if (decision.action === "halt") {
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      await tx.query(
        "UPDATE tg_runtime SET block_reason=$1, blocked_at=now(),last_error_code=$1 WHERE id=1",
        [decision.code]
      );
      await tx.query(`UPDATE tg_jobs SET state='failed',locked_until=NULL,
        last_error=$2,updated_at=now() WHERE id=$1`, [job.id, decision.code]);
      await tx.query("COMMIT");
    } catch (failure) {
      await tx.query("ROLLBACK");
      throw failure;
    } finally { tx.release(); }
    console.error("TG Collector halted:", decision.code, message);
    return "halt";
  }
  if (decision.action === "delay") {
    if (decision.global) {
      await pool.query(`UPDATE tg_runtime SET pause_until=GREATEST(
        COALESCE(pause_until,now()),now()+($1::int * interval '1 second')),
        last_error_code=$2 WHERE id=1`, [decision.seconds, decision.code]);
    }
    await pool.query(`UPDATE tg_jobs SET state='delayed',
      run_at=now()+($2::int * interval '1 second'),
      locked_until=NULL,last_error=$3,updated_at=now() WHERE id=$1`,
      [job.id, decision.seconds, decision.code]);
    console.warn("TG job delayed", job.id, decision.code, decision.seconds);
    return "continue";
  }
  await pool.query(`UPDATE tg_jobs SET state='failed',locked_until=NULL,
    last_error=$2,updated_at=now() WHERE id=$1`, [job.id, decision.code + ": " + message]);
  console.error("TG job permanently failed", job.id, decision.code);
  return "continue";
}
