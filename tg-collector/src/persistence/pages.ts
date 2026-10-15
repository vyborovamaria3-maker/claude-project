import { pool } from "../db.js";
import { persistMessage } from "./messages.js";
import type { Job } from "../queue/jobs.js";
import type { RawTelegramMessage as TgMessage } from "../analytics/extract.js";
export async function storePage(job: Job, rows: TgMessage[], lowId: number): Promise<void> {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    for (const msg of rows) await persistMessage(tx, job.source_id, msg);
    await tx.query(`UPDATE tg_jobs SET cursor_before_id=$2,
      scanned_count=scanned_count+$3, locked_until=now()+interval '15 minutes',
      updated_at=now() WHERE id=$1`, [job.id, lowId, rows.length]);
    await tx.query("COMMIT");
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally { tx.release(); }
}

