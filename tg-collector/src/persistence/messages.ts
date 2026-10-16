import type { PoolClient } from "pg";
import { ANALYSIS_VERSION, extractLinks, type RawTelegramMessage } from "../analytics/extract.js";

export async function persistMessage(
  tx: PoolClient, sourceId: string, msg: RawTelegramMessage
): Promise<void> {
  if (!Number.isSafeInteger(msg.id) || msg.id <= 0 || typeof msg.message !== "string") return;
  await tx.query(
    `INSERT INTO tg_messages(source_id,message_id,sender_id,posted_at,text,views,forwards,replies,analysis_version,deleted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL)
     ON CONFLICT(source_id,message_id) DO UPDATE SET
       sender_id=EXCLUDED.sender_id, posted_at=EXCLUDED.posted_at,
       text=EXCLUDED.text, views=EXCLUDED.views,
       forwards=EXCLUDED.forwards, replies=EXCLUDED.replies,
       collected_at=now(), analysis_version=EXCLUDED.analysis_version, deleted_at=NULL`,
    [sourceId, msg.id, msg.senderId?.toString() ?? null,
      typeof msg.date === "number" ? new Date(msg.date * 1000) : null,
      msg.message, msg.views ?? null, msg.forwards ?? null,
      msg.replies?.replies ?? null, ANALYSIS_VERSION]
  );
  await replaceEvidence(tx, sourceId, msg);
}

export async function replaceEvidence(
  tx: PoolClient, sourceId: string, msg: RawTelegramMessage,
  options: { preserveExistingForwards?: boolean } = {}
): Promise<void> {
  // Reconstructing the complete set per message avoids stale evidence after edits/retries.
  await tx.query(`DELETE FROM tg_message_links WHERE source_id=$1 AND message_id=$2
    AND ($3::boolean=false OR kind <> 'forward')`, [sourceId, msg.id, options.preserveExistingForwards === true]);
  for (const link of extractLinks(msg)) {
    await tx.query(
      `INSERT INTO tg_message_links(source_id,message_id,kind,target_kind,target_key,analysis_version)
       VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [sourceId, msg.id, link.kind, link.targetKind, link.targetKey, ANALYSIS_VERSION]
    );
  }
  await tx.query("UPDATE tg_messages SET analysis_version=$3 WHERE source_id=$1 AND message_id=$2",
    [sourceId, msg.id, ANALYSIS_VERSION]);
}
