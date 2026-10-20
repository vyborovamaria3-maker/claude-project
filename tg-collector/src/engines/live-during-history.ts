import type { TelegramClient } from "telegram";
import { pool } from "../db.js";
import type { Job } from "../queue/jobs.js";
import { persistMessage } from "../persistence/messages.js";
import { refreshGraphDays, utcDay } from "../analytics/rollups.js";
import { batchSize } from "../runtime/config.js";
import type { RawTelegramMessage } from "../analytics/extract.js";

/** New-post scan independent of the long-running oldest-history checkpoint.
 * Checkpoint moves atomically with persistence; source high-watermark moves only
 * after the complete [base, high] interval is collected.
 * Returns false when the foreground scan needs another worker turn.
 */
export async function catchUpFreshPosts(
  client: TelegramClient, entity: Parameters<TelegramClient["getMessages"]>[0],
  job: Job, sourceLastId: number,
): Promise<boolean> {
  if (!Number.isSafeInteger(sourceLastId) || sourceLastId <= 0) return true;
  let base = Number(job.fresh_base_message_id ?? sourceLastId);
  let high = Number(job.fresh_high_message_id ?? 0);
  let cursor = Number(job.fresh_cursor_before_id ?? 0);

  if (!high) {
    const state = await pool.query<{ live_checked_at: Date | null }>(
      "SELECT live_checked_at FROM tg_sources WHERE id=$1", [job.source_id]);
    const checked = state.rows[0]?.live_checked_at;
    if (checked && Date.now() - new Date(checked).getTime() < 30_000) return true;
    const latest = await client.getMessages(entity, {limit: 1});
    await pool.query("UPDATE tg_sources SET live_checked_at=now() WHERE id=$1", [job.source_id]);
    high = Number(latest[0]?.id ?? 0);
    if (high <= base) return true;
    await pool.query(`UPDATE tg_jobs SET fresh_base_message_id=$2,
      fresh_high_message_id=$3,fresh_cursor_before_id=NULL,updated_at=now()
      WHERE id=$1`, [job.id,base,high]);
  }

  for (let page = 0; page < 2; page++) {
    const active = await pool.query<{ ok: boolean }>(`
      SELECT s.enabled AND r.collection_enabled AND r.block_reason IS NULL
      AND (r.pause_until IS NULL OR r.pause_until<=now()) AS ok
      FROM tg_sources s CROSS JOIN tg_runtime r
      WHERE s.id=$1 AND r.id=1`, [job.source_id]);
    if (!active.rows[0]?.ok) return false;
    const messages = await client.getMessages(entity, {
      limit: batchSize, offsetId: cursor || high + 1, minId: base,
    }) as unknown as RawTelegramMessage[];
    if (!messages.length) {
      const tx = await pool.connect();
      try {
        await tx.query("BEGIN");
        await tx.query("UPDATE tg_sources SET last_message_id=GREATEST(last_message_id,$2) WHERE id=$1",
          [job.source_id, high]);
        await tx.query(`UPDATE tg_jobs SET fresh_base_message_id=NULL,
          fresh_high_message_id=NULL,fresh_cursor_before_id=NULL,updated_at=now()
          WHERE id=$1`, [job.id]);
        await tx.query("COMMIT");
      } catch (error) {
        await tx.query("ROLLBACK"); throw error;
      } finally { tx.release(); }
      return true;
    }
    const low = Math.min(...messages.map(row => row.id));
    if (!Number.isSafeInteger(low) || low <= 0 || (cursor && low >= cursor)) {
      throw new Error("TG_FRESH_CURSOR_INVALID: new message cursor did not advance");
    }
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      const prior = await tx.query<{posted_at:Date|null}>(
        "SELECT posted_at FROM tg_messages WHERE source_id=$1 AND message_id=ANY($2::bigint[])",
        [job.source_id, messages.map(row => row.id)]);
      const days = prior.rows.map(row => utcDay(row.posted_at)).filter((day):day is string => day !== null);
      for (const message of messages) {
        await persistMessage(tx, job.source_id, message);
        const day = typeof message.date === "number" ? utcDay(new Date(message.date*1000)) : null;
        if (day) days.push(day);
      }
      await refreshGraphDays(tx, job.source_id, days);
      await tx.query("UPDATE tg_jobs SET fresh_cursor_before_id=$2,updated_at=now() WHERE id=$1",
        [job.id, low]);
      await tx.query("COMMIT");
    } catch (error) {
      await tx.query("ROLLBACK"); throw error;
    } finally {tx.release();}
    cursor = low;
  }
  return false;
}
