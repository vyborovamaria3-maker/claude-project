import { pool } from "../db.js";
import { persistMessage } from "./messages.js";
import { refreshGraphDays, utcDay } from "../analytics/rollups.js";
import type { Job } from "../queue/jobs.js";
import type { RawTelegramMessage as TgMessage } from "../analytics/extract.js";
export async function storePage(job: Job, rows: TgMessage[], lowId: number): Promise<void> {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const oldRows = await tx.query<{posted_at: Date | null}>(
      "SELECT posted_at FROM tg_messages WHERE source_id=$1 AND message_id = ANY($2::bigint[])",
      [job.source_id, rows.map(m => m.id)]
    );
    const affectedDays = oldRows.rows.map(r => utcDay(r.posted_at)).filter((x): x is string => x !== null);
    for (const msg of rows) {
      await persistMessage(tx, job.source_id, msg);
      const day = typeof msg.date === "number" ? utcDay(new Date(msg.date*1000)) : null;
      if (day) affectedDays.push(day);
    }
    await refreshGraphDays(tx, job.source_id, affectedDays);
    await tx.query(`UPDATE tg_sources SET history_low_message_id =
      CASE WHEN history_low_message_id=0 THEN $2::bigint ELSE LEAST(history_low_message_id,$2::bigint) END
      WHERE id=$1`, [job.source_id, lowId]);
    await tx.query(`UPDATE tg_jobs SET cursor_before_id=$2,
      scanned_count=scanned_count+$3, locked_until=now()+interval '15 minutes',
      updated_at=now() WHERE id=$1`, [job.id, lowId, rows.length]);
    await tx.query("COMMIT");
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally { tx.release(); }
}

