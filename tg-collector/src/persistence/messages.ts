import {matchesSearchTerm} from "../runtime/message-search.js";
import {createHash} from "node:crypto";
import type { PoolClient } from "pg";
import { ANALYSIS_VERSION, extractLinks, type RawTelegramMessage } from "../analytics/extract.js";
import { refreshGraphDays, utcDay } from "../analytics/rollups.js";
import { syncMessageTokenCandidates } from "../analytics/token-intelligence.js";
import { emitTgMessageOutbox, emitTgDeletionOutbox, emitTgTokenLinksInvalidation, telegramVerifiedTokenLinksEnabled } from "./outbox.js";

export function reactionCounts(msg:RawTelegramMessage){
 return (msg.reactions?.results??[]).slice(0,100).filter(r=>Number.isSafeInteger(r.count)&&Number(r.count)>=0).map(r=>({
  emoji:r.reaction?.emoticon??null,customEmojiId:r.reaction?.documentId?.toString()??null,count:r.count
 }));
}
export async function persistMessage(
  tx: PoolClient, sourceId: string, msg: RawTelegramMessage
): Promise<void> {
  if (!Number.isSafeInteger(msg.id) || msg.id <= 0 || typeof msg.message !== "string") return;
  const rawReplyId = msg.replyToMsgId ?? msg.replyTo?.replyToMsgId;
  const parsedReplyId = typeof rawReplyId === "number" ? rawReplyId : rawReplyId ? Number(rawReplyId.toString()) : null;
  const replyToMessageId = parsedReplyId !== null && Number.isSafeInteger(parsedReplyId) && parsedReplyId > 0 && parsedReplyId !== msg.id
    ? parsedReplyId : null;
  // For historical token evidence, changed text or restoration must revoke
  // ALL previously verified message links. Mere views/likes updates do not.
  // The message row is locked through the same native PG transaction.
  const previous=telegramVerifiedTokenLinksEnabled()
    ? (await tx.query<{text:string|null;deleted_at:Date|null;posted_at:Date|null}>(
        "SELECT text,deleted_at,posted_at FROM tg_messages WHERE source_id=$1 AND message_id=$2 FOR UPDATE",
        [sourceId,msg.id],
      )).rows[0]
    : undefined;
  await tx.query(
    `INSERT INTO tg_messages(source_id,message_id,sender_id,posted_at,text,views,forwards,replies,analysis_version,deleted_at,edited_at,reply_to_message_id,reactions,engagement_observed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10,$11,$12::jsonb,now())
     ON CONFLICT(source_id,message_id) DO UPDATE SET
       sender_id=EXCLUDED.sender_id, posted_at=EXCLUDED.posted_at,
       text=EXCLUDED.text, views=EXCLUDED.views,
       forwards=EXCLUDED.forwards, replies=EXCLUDED.replies, edited_at=EXCLUDED.edited_at, reply_to_message_id=EXCLUDED.reply_to_message_id,
       reactions=EXCLUDED.reactions,engagement_observed_at=now(),collected_at=now(), analysis_version=EXCLUDED.analysis_version, deleted_at=NULL`,
    [sourceId, msg.id, msg.senderId?.toString() ?? null,
      typeof msg.date === "number" ? new Date(msg.date * 1000) : null,
      msg.message, msg.views ?? null, msg.forwards ?? null,
      msg.replies?.replies ?? null, ANALYSIS_VERSION,
      typeof msg.editDate === "number" ? new Date(msg.editDate * 1000) : null,
      replyToMessageId,JSON.stringify(reactionCounts(msg))]
  );
  if (replyToMessageId !== null) {
    await tx.query("INSERT INTO tg_message_threads(source_id,message_id,reply_to_message_id) VALUES($1,$2,$3) " +
      "ON CONFLICT(source_id,message_id) DO UPDATE SET reply_to_message_id=EXCLUDED.reply_to_message_id,observed_at=now()",
      [sourceId, msg.id, replyToMessageId]);
  } else {
    await tx.query("DELETE FROM tg_message_threads WHERE source_id=$1 AND message_id=$2", [sourceId, msg.id]);
  }
  const lookup=(await tx.query<{message_terms:string[];peer_id:string;identifier:string;title:string}>(`SELECT d.message_terms,s.peer_id,s.identifier,s.title FROM tg_discovery_settings d CROSS JOIN tg_sources s
   WHERE d.id=1 AND d.enabled AND d.message_search_enabled AND s.id=$1 AND s.peer_id IS NOT NULL
   AND EXISTS(SELECT 1 FROM unnest(d.message_terms) term WHERE position(lower(term) in lower($2))>0)`,[sourceId,msg.message])).rows[0];
  if(lookup){
   const terms=lookup.message_terms.filter(term=>matchesSearchTerm(msg.message!,term));
   if(terms.length){
    await tx.query(`INSERT INTO tg_discovery_mentions(peer_id,message_id,username,title,text,posted_at,matched_terms,source_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(peer_id,message_id) DO UPDATE SET text=EXCLUDED.text,last_seen_at=now(),source_id=EXCLUDED.source_id,
      matched_terms=(SELECT ARRAY(SELECT DISTINCT unnest(tg_discovery_mentions.matched_terms||EXCLUDED.matched_terms)))`,
      [lookup.peer_id,msg.id,lookup.identifier,lookup.title??lookup.identifier,msg.message.slice(0,8192),typeof msg.date==='number'?new Date(msg.date*1000):null,terms,sourceId]);
    await tx.query('UPDATE tg_sources SET full_history=TRUE WHERE id=$1',[sourceId]);
   }
  }
  await replaceEvidence(tx, sourceId, msg);
  if(previous && (previous.text!==msg.message || previous.deleted_at!==null)){
    // Invalidate native confirmed status too: a newer source revision must
    // undergo another real RPC mint-account check, even when the same literal
    // address remains in edited/restored text. Candidate rows were already
    // refreshed by replaceEvidence() above.
    await tx.query(
      "UPDATE tg_token_candidates SET resolution_status='unresolved'," +
      "confidence=NULL,provider=NULL,checked_at=NULL " +
      "WHERE source_id=$1 AND message_id=$2 AND analysis_version=$3 " +
      "AND candidate_type='address' AND resolution_status='confirmed_token'",
      [sourceId,msg.id,ANALYSIS_VERSION],
    );
    await tx.query(
      "UPDATE tg_token_mentions SET orphaned=TRUE " +
      "WHERE source_id=$1 AND message_id=$2 AND analysis_version=$3",
      [sourceId,msg.id,ANALYSIS_VERSION],
    );
    const sourceRevisionSha256=createHash("sha256").update(JSON.stringify([
      "edited",msg.message,msg.editDate??null,
    ])).digest("hex");
    await emitTgTokenLinksInvalidation(tx,sourceId,{
      messageId:msg.id,reason:"edited",sourceRevisionSha256,
      observedAt:new Date(),postedAt:previous.posted_at,
    });
  }
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
  if(telegramVerifiedTokenLinksEnabled()){
    const sourceRevisionSha256=createHash("sha256")
      .update("deleted:"+result.rows[0]!.deletion_revision).digest("hex");
    await emitTgTokenLinksInvalidation(tx,sourceId,{
      messageId,reason:"deleted",sourceRevisionSha256,
      observedAt:result.rows[0]!.deleted_at,
      postedAt:result.rows[0]!.posted_at,
    });
  }
  return true;
}
