import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {dirname,resolve} from "node:path";

const here=dirname(fileURLToPath(import.meta.url));
const DAY_MS=86_400_000;

export async function installSchema(pool){
  const sql=await readFile(resolve(here,"../schema.sql"),"utf8");
  await pool.query(sql);
}

function requireRetention(days){
  if(!Number.isInteger(days)||days<1||days>365)throw new TypeError("Invalid retention days");
}

export function isExpiredObservation(observation,retentionDays,clock=new Date()){
  requireRetention(retentionDays);
  if(observation.kind==="deleted")return false; // A delete must always erase previously saved content.
  // Do not silently retain message text when original publication date is missing.
  if(!observation.occurredAt)throw new Error("Cannot retain message without a source publication timestamp");
  const published=Date.parse(observation.occurredAt);
  if(!Number.isFinite(published))throw new TypeError("Invalid source publication time");
  // Future-dated data is not proof of historical publication and must be rejected.
  if(published>clock.getTime()+5*60_000)throw new Error("Future-dated Discord message");
  return published < clock.getTime()-retentionDays*DAY_MS;
}

export async function storeObservation(pool, o, retentionDays, clock=new Date()){
  if(isExpiredObservation(o,retentionDays,clock))return {status:"expired"};
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const previous=await client.query(
      "SELECT guild_id,channel_id,deleted_at,revision_at,content_sha256 "+
      "FROM discord_messages WHERE message_id=$1 FOR UPDATE",[o.messageId]);
    const old=previous.rows[0]??null;
    if(old&&(old.guild_id!==o.guildId||old.channel_id!==o.channelId))
      throw new Error("Discord message identity reused in another guild/channel");
    if(old?.deleted_at&&o.kind!=="deleted"){
      await client.query("COMMIT");
      return {status:"tombstoned"};
    }
    const oldRevision=old?.revision_at ? new Date(old.revision_at).getTime() : null;
    const newRevision=o.revisionAt ? Date.parse(o.revisionAt) : null;
    const stale=o.kind!=="deleted" && oldRevision!==null &&
      (newRevision===null||newRevision<oldRevision);
    if(o.kind!=="deleted" && oldRevision!==null && newRevision===oldRevision &&
       old.content_sha256!==o.contentSha)
      throw new Error("Conflicting content for identical Discord source revision");
    // Stale HTTP history is recorded as metadata only, never resurrecting old text.
    const retainedContent=stale?null:o.content;
    const retainedHash=stale?null:o.contentSha;
    await client.query(
      "INSERT INTO discord_message_revisions "+
      "(message_id,guild_id,channel_id,revision_key,event_kind,observed_at,content_sha256,content) "+
      "VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING",
      [o.messageId,o.guildId,o.channelId,o.revisionKey,o.kind,o.observedAt,
       retainedHash,retainedContent]);
    if(o.kind==="deleted"){
      await client.query(
        "INSERT INTO discord_messages "+
        "(message_id,guild_id,channel_id,author_id,occurred_at,observed_at,edited_at,content,content_sha256,deleted_at,revision_at) "+
        "VALUES($1,$2,$3,NULL,NULL,$4,NULL,NULL,NULL,$4,NULL) "+
        "ON CONFLICT(message_id) DO UPDATE SET "+
        "deleted_at=COALESCE(discord_messages.deleted_at,EXCLUDED.deleted_at),"+
        "content=NULL,content_sha256=NULL,author_id=NULL,"+
        "observed_at=LEAST(discord_messages.observed_at,EXCLUDED.observed_at)",
        [o.messageId,o.guildId,o.channelId,o.observedAt]);
      await client.query(
        "UPDATE discord_message_revisions SET content=NULL,content_sha256=NULL "+
        "WHERE message_id=$1",[o.messageId]);
    }else if(!stale){
      await client.query(
        "INSERT INTO discord_messages "+
        "(message_id,guild_id,channel_id,author_id,occurred_at,observed_at,edited_at,content,content_sha256,revision_at) "+
        "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) "+
        "ON CONFLICT(message_id) DO UPDATE SET "+
        "author_id=COALESCE(EXCLUDED.author_id,discord_messages.author_id),"+
        "occurred_at=COALESCE(discord_messages.occurred_at,EXCLUDED.occurred_at),"+
        "observed_at=LEAST(discord_messages.observed_at,EXCLUDED.observed_at),"+
        "edited_at=EXCLUDED.edited_at,content=EXCLUDED.content,"+
        "content_sha256=EXCLUDED.content_sha256,revision_at=EXCLUDED.revision_at "+
        "WHERE discord_messages.deleted_at IS NULL "+
        "AND (discord_messages.revision_at IS NULL OR EXCLUDED.revision_at>discord_messages.revision_at "+
        "OR (EXCLUDED.revision_at=discord_messages.revision_at "+
        "AND EXCLUDED.content_sha256 IS NOT DISTINCT FROM discord_messages.content_sha256))",
        [o.messageId,o.guildId,o.channelId,o.authorId,o.occurredAt,o.observedAt,
         o.editedAt,o.content,o.contentSha,o.revisionAt]);
    }
    await client.query("COMMIT");
    return {status:stale?"stale":o.kind==="deleted"?"deleted":"stored"};
  }catch(e){await client.query("ROLLBACK");throw e}
  finally{client.release()}
}

export async function purgeExpired(pool,allowed){
  // Run at startup and on a recurring schedule. A missing authorization is a hard
  // revocation: do not retain content from channels removed from the allowlist.
  if(!(allowed instanceof Map)||allowed.size===0)throw new Error("No authorized channels");
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    let removed=0;
    const revoked=[...allowed.keys()];
    const r=await client.query(
      "DELETE FROM discord_message_revisions WHERE message_id IN "+
      "(SELECT message_id FROM discord_messages WHERE NOT (channel_id=ANY($1::text[])))",[revoked]);
    removed+=r.rowCount;
    const revokedMsg=await client.query(
      "DELETE FROM discord_messages WHERE NOT (channel_id=ANY($1::text[]))",[revoked]);
    removed+=revokedMsg.rowCount;
    await client.query("DELETE FROM discord_backfill_cursors WHERE NOT (channel_id=ANY($1::text[]))",[revoked]);
    for(const [channelId,permission] of allowed){
      requireRetention(permission.retentionDays);
      const args=[channelId,permission.retentionDays];
      const expired="SELECT message_id FROM discord_messages WHERE channel_id=$1 "+
        "AND COALESCE(occurred_at,observed_at)<NOW()-($2::integer*INTERVAL '1 day')";
      const revisions=await client.query(
        "DELETE FROM discord_message_revisions WHERE message_id IN ("+expired+")",args);
      const messages=await client.query(
        "DELETE FROM discord_messages WHERE message_id IN ("+expired+")",args);
      removed+=revisions.rowCount+messages.rowCount;
    }
    await client.query("COMMIT");
    return {rowsErased:removed};
  }catch(e){await client.query("ROLLBACK");throw e}
  finally{client.release()}
}

export async function getRecoveryBaseline(pool,channelId){
  // A previous bounded scan may have exhausted its page budget; preserve that
  // unresolved low watermark across restarts rather than concealing a gap behind
  // newly ingested Gateway messages.
  const pending=await pool.query(
    "SELECT baseline_message_id FROM discord_recovery_checks "+
    "WHERE channel_id=$1 AND status='gap_unresolved' AND resolved_at IS NULL "+
    "AND baseline_message_id IS NOT NULL ORDER BY checked_at ASC LIMIT 1",[channelId]);
  if(pending.rows[0])return pending.rows[0].baseline_message_id;
  const latest=await pool.query(
    "SELECT message_id FROM discord_messages WHERE channel_id=$1 "+
    "ORDER BY message_id::numeric DESC LIMIT 1",[channelId]);
  return latest.rows[0]?.message_id??null;
}

export async function recordRecoveryCheck(pool,guildId,channelId,baseline,results){
  const status=results.status;
  if(!["initial_unverified","bounded_recovery","gap_unresolved","failed"].includes(status))
    throw new TypeError("Unrecognized recovery status");
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO discord_recovery_checks "+
      "(guild_id,channel_id,baseline_message_id,status,pages_scanned,messages_processed) "+
      "VALUES($1,$2,$3,$4,$5,$6)",
      [guildId,channelId,baseline,status,results.pagesScanned??0,results.messagesProcessed??0]);
    if(status==="bounded_recovery"){
      await client.query(
        "UPDATE discord_recovery_checks SET resolved_at=NOW() "+
        "WHERE channel_id=$1 AND baseline_message_id IS NOT DISTINCT FROM $2 "+
        "AND status='gap_unresolved' AND resolved_at IS NULL",
        [channelId,baseline]);
    }
    await client.query("COMMIT");
  }catch(e){await client.query("ROLLBACK");throw e}
  finally{client.release()}
}

export async function getBackfillCursor(pool,channelId){
  const {rows}=await pool.query(
    "SELECT before_message_id FROM discord_backfill_cursors WHERE channel_id=$1",[channelId]);
  return rows[0]?.before_message_id??null;
}

export async function advanceBackfillCursor(pool,guildId,channelId,beforeId){
  await pool.query(
    "INSERT INTO discord_backfill_cursors(guild_id,channel_id,before_message_id,updated_at) "+
    "VALUES($1,$2,$3,NOW()) ON CONFLICT(channel_id) DO UPDATE SET "+
    "before_message_id=EXCLUDED.before_message_id,updated_at=NOW()",
    [guildId,channelId,beforeId]);
}
