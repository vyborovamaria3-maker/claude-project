import { pool } from "../db.js";
import { telegramWaitSeconds } from "../validation.js";
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
      WHERE s.enabled AND ((j.state IN ('pending','delayed') AND j.run_at <= now())
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


export async function handleFailure(job: Job, error: unknown): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0,300);
  const seconds = telegramWaitSeconds(error);
  if (seconds !== null) {
    const wait = Math.min(seconds + 15, 86400 * 30);
    await pool.query(
      "UPDATE tg_runtime SET pause_until=GREATEST(COALESCE(pause_until, now()), now()+($1::int * interval '1 second')) WHERE id=1",
      [wait]);
    await pool.query(`UPDATE tg_jobs SET state='delayed',run_at=now()+($2::int * interval '1 second'),
      locked_until=NULL,last_error=$3,updated_at=now() WHERE id=$1`, [job.id, wait, "FLOOD_WAIT"]);
    console.warn("Telegram requested a pause (seconds):", seconds);
    return;
  }
  const permanent = /CHANNEL_PRIVATE|USERNAME_INVALID|USERNAME_NOT_OCCUPIED|CHAT_ADMIN_REQUIRED|USER_NOT_PARTICIPANT|TG_SOURCE_UNSUPPORTED/.test(message);
  const retry = !permanent && job.attempts < 5;
  const wait = Math.min(900, Math.pow(2, job.attempts) * 15);
  await pool.query(`UPDATE tg_jobs SET state=$2,run_at=now()+($3::int * interval '1 second'),
    locked_until=NULL,last_error=$4,updated_at=now() WHERE id=$1`,
    [job.id, retry ? "delayed" : "failed", wait, message]);
  console.error("TG job error:", job.id, message);
}

