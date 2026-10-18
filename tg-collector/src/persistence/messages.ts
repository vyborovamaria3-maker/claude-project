import type { PoolClient } from "pg";
import { ANALYSIS_VERSION, extractLinks, type RawTelegramMessage } from "../analytics/extract.js";
import { refreshGraphDays, utcDay } from "../analytics/rollups.js";
import { syncMessageTokenCandidates } from "../analytics/token-intelligence.js";
import { emitTgMessageOutbox, emitTgDeletionOutbox } from "./outbox.js";

export async function persistMessage(
  tx: PoolClient, sourceId: string, msg: RawTelegramMessage
): Promise<void> {
  if (!Number.isSafeInteger(msg.id) || msg.id <= 0 || typeof msg.message !== "string") return;
  const rawReplyId = msg.replyToMsgId ?? msg.replyTo?.replyToMsgId;
  const parsedReplyId = typeof rawReplyId === "number" ? rawReplyId : rawReplyId ? Number(rawReplyId.toString()) : null;
  const replyToMessageId = parsedReplyId !== null && Number.isSafeInteger(parsedReplyId) && parsedReplyId > 0 && parsedReplyId !== msg.id
    ? parsedReplyId : null;
  await tx.query(
    `INSERT INTO tg_messages(source_id,message_id,sender_id,posted_at,text,views,forwards,replies,analysis_version,deleted_at,edited_at,reply_to_message_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10,$11)
     ON CONFLICT(source_id,message_id) DO UPDATE SET
       sender_id=EXCLUDED.sender_id, posted_at=EXCLUDED.posted_at,
       text=EXCLUDED.text, views=EXCLUDED.views,
       forwards=EXCLUDED.forwards, replies=EXCLUDED.replies, edited_at=EXCLUDED.edited_at, reply_to_message_id=EXCLUDED.reply_to_message_id,
       collected_at=now(), analysis_version=EXCLUDED.analysis_version, deleted_at=NULL`,
    [sourceId, msg.id, msg.senderId?.toString() ?? null,
      typeof msg.date === "number" ? new Date(msg.date * 1000) : null,
      msg.message, msg.views ?? null, msg.forwards ?? null,
      msg.replies?.replies ?? null, ANALYSIS_VERSION,
      typeof msg.editDate === "number" ? new Date(msg.editDate * 1000) : null,
      replyToMessageId]
  );
  if (replyToMessageId !== null) {
    await tx.query("INSERT INTO tg_message_threads(source_id,message_id,reply_to_message_id) VALUES($1,$2,$3) " +
      "ON CONFLICT(source_id,message_id) DO UPDATE SET reply_to_message_id=EXCLUDED.reply_to_message_id,observed_at=now()",
      [sourceId, msg.id, replyToMessageId]);
  } else {
    await tx.query("DELETE FROM tg_message_threads WHERE source_id=$1 AND message_id=$2", [sourceId, msg.id]);
  }
  await replaceEvidence(tx, sourceId, msg);
  await emitTgMessageOutbox(tx, sourceId, msg);
}

export async function replaceEvidence(
  tx: PoolClient, sourceId: string, msg: RawTelegramMessage,
  options: { preserveExistingForwards?: boolean } = {}
): Promise<void> {
  // Reconstructing the complete set per message avoids stale evidence after edits/retries.
  await tx.query(`DELETE FROM tg_message_links WHERE source_id=$1 AND message_id=$2
    AND ($3::boolean=false OR kind <> 'forward')`, [sourceId, msg.id, options.preserveExistingForwards === true]);
  const links = extractLinks(msg);
  for (const link of links) {
    await tx.query(
      `INSERT INTO tg_message_links(source_id,message_id,kind,target_kind,target_key,analysis_version)
       VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [sourceId, msg.id, link.kind, link.targetKind, link.targetKey, ANALYSIS_VERSION]
    );
  }
  await syncMessageTokenCandidates(tx, sourceId, msg, links);
  await tx.query("UPDATE tg_messages SET analysis_version=$3 WHERE source_id=$1 AND message_id=$2",
    [sourceId, msg.id, ANALYSIS_VERSION]);
}


/**
 * Soft-delete a Telegram message without deleting canonical evidence links.
 * The affected UTC graph day is rebuilt in the same transaction.
 */
export async function markMessageDeleted(
  tx: PoolClient, sourceId: string, messageId: number,
): Promise<boolean> {
  const result = await tx.query<{ posted_at: Date | null; deleted_at: Date; deletion_revision: string }>(
    `UPDATE tg_messages
     SET deleted_at = COALESCE(deleted_at, clock_timestamp())
     WHERE source_id=$1 AND message_id=$2 AND deleted_at IS NULL
     RETURNING posted_at, deleted_at, to_char(deleted_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS') AS deletion_revision`,
    [sourceId, messageId],
  );
  if (!result.rowCount) return false;
  const day = utcDay(result.rows[0]?.posted_at);
  if (day) await refreshGraphDays(tx, sourceId, [day]);
  await emitTgDeletionOutbox(tx, sourceId, messageId,
    result.rows[0]!.deleted_at, result.rows[0]!.deletion_revision);
  return true;
}
