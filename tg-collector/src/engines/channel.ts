import { setTimeout as sleep } from "node:timers/promises";
import type { TelegramClient } from "telegram";
import { pool } from "../db.js";
import type { Job } from "../queue/jobs.js";
import { finishJob } from "../queue/jobs.js";
import { storePage } from "../persistence/pages.js";
import { batchSize, initialLimit, maxPages } from "../runtime/config.js";
import type { RawTelegramMessage as TgMessage } from "../analytics/extract.js";
type Source = { identifier: string; last_message_id: string };

export async function processJob(client: TelegramClient, job: Job, isStopping: () => boolean): Promise<void> {
  const { rows } = await pool.query<Source>(
    "SELECT identifier,last_message_id FROM tg_sources WHERE id=$1", [job.source_id]);
  const source = rows[0];
  if (!source) throw new Error("Source was deleted");

  const entity = await client.getEntity(source.identifier);
  // Never collect from user profiles/DMs: this module is channel/group-only.
  const channel = entity as { className?: string; id?: {toString(): string}; title?: string };
  if (channel.className !== "Channel") {
    throw new Error("TG_SOURCE_UNSUPPORTED: only public channels and supergroups are allowed");
  }
  await pool.query("UPDATE tg_sources SET peer_id=$2,title=$3 WHERE id=$1",
    [job.source_id, channel.id?.toString() ?? null, channel.title ?? source.identifier]);

  const baseId = Number(job.base_message_id ?? source.last_message_id);
  let highId = job.high_message_id ? Number(job.high_message_id) : 0;
  let cursor = job.cursor_before_id ? Number(job.cursor_before_id) : 0;
  let scanned = job.scanned_count;

  if (!job.high_message_id) {
    const latest = await client.getMessages(entity, {limit:1});
    highId = latest[0]?.id ?? 0;
    await pool.query(
      "UPDATE tg_jobs SET base_message_id=$2,high_message_id=$3,updated_at=now() WHERE id=$1",
      [job.id, baseId, highId]
    );
  }

  if (highId <= baseId) {
    await finishJob(job, Math.max(baseId, highId), false);
    return;
  }

  for (let page=0; page<maxPages && !isStopping(); page++) {
    const activeSource = await pool.query<{enabled:boolean}>(`SELECT s.enabled AND r.collection_enabled AND r.block_reason IS NULL
      AND (r.pause_until IS NULL OR r.pause_until <= now()) AS enabled
      FROM tg_sources s CROSS JOIN tg_runtime r WHERE s.id=$1 AND r.id=1`, [job.source_id]);
    if (!activeSource.rows[0]?.enabled) {
      await pool.query("UPDATE tg_jobs SET state='pending', locked_until=NULL, run_at=now()+interval '5 seconds' WHERE id=$1", [job.id]);
      return;
    }
    const batch = await client.getMessages(entity, {
      limit: batchSize,
      offsetId: cursor || highId+1,
      minId: baseId,
    });
    const messages = batch as unknown as TgMessage[];
    if (!messages.length) {
      await finishJob(job, highId, false);
      console.log("Synced", source.identifier, "to", highId);
      return;
    }
    const lowId = Math.min(...messages.map(m=>m.id));
    if (!Number.isFinite(lowId) || (cursor && lowId >= cursor)) {
      throw new Error("Telegram history cursor did not advance");
    }
    await storePage(job, messages, lowId);
    cursor=lowId;
    scanned+=messages.length;
    const initialCutoff = baseId === 0 && scanned >= initialLimit;
    if (messages.length < batchSize || initialCutoff) {
      await finishJob(job, highId, initialCutoff && messages.length===batchSize);
      console.log("Synced", source.identifier, messages.length, "latest batch", "high", highId);
      return;
    }
    await sleep(250);
  }
  // The checkpoint is not advanced until the whole new-message range is captured.
  await pool.query(`UPDATE tg_jobs SET state='pending',
    attempts=0, locked_until=NULL, run_at=now()+interval '5 seconds',
    updated_at=now() WHERE id=$1`, [job.id]);
}


