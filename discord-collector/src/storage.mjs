import {createHash} from "node:crypto";
import {emitPostgres,POSTGRES_OUTBOX_DDL} from "@claude-project/event-outbox";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {dirname,resolve} from "node:path";

const here=dirname(fileURLToPath(import.meta.url));
const DAY_MS=86_400_000;

export async function installSchema(pool){
  const sql=await readFile(resolve(here,"../schema.sql"),"utf8");
  await pool.query(sql);
  await pool.query(POSTGRES_OUTBOX_DDL);
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


async function emitDiscordObservation(client,o){
  const eventKind=o.kind==="observed"?"message_observed":o.kind==="edited"?"message_edited":"message_deleted";
  const eventKey=["discord:message",o.channelId,o.messageId,o.revisionKey].join(":");
  const payload={
    kind:o.kind,channelId:o.channelId,messageId:o.messageId,revisionKey:o.revisionKey,
    observedAt:o.observedAt,
    occurredAt:o.kind==="deleted"?null:o.kind==="edited"?o.editedAt:o.occurredAt,
    contentSha256:o.kind==="deleted"?null:o.contentSha,
    ...(o.kind==="deleted"?{contentErased:true,deletionReason:o.deletionReason??"deleted"}:{}),
    producerVersion:"0.1.0",
  };
  // The outbox insert uses the SAME transaction as message/revision storage.
  // No raw content, author ID, guild ID or attachment URL crosses this boundary.
  await emitPostgres(client,{
    sourceSystem:"discord",eventKind,eventKey,schemaVersion:"discord-message-v1",payload,
  });
}

function erasureObservation(row,reason,observedAt){
  const revisionKey=createHash("sha256")
    .update([row.guild_id,row.channel_id,row.message_id,"deleted","","",reason].join("|"))
    .digest("hex");
  return {
    kind:"deleted",guildId:row.guild_id,channelId:row.channel_id,messageId:row.message_id,
    revisionKey,observedAt,occurredAt:null,editedAt:null,revisionAt:null,
    content:null,contentSha:null,deletionReason:reason,
  };
}

async function enqueueErasureTombstones(client,rows,reason){
  const observedAt=new Date().toISOString();
  let queued=0;
  for(const row of rows){
    await client.query("SELECT pg_advisory_xact_lock(hashtext('discord'),hashtext($1))",[row.message_id]);
    const inserted=await client.query(
      "INSERT INTO discord_message_tombstones "+
      "(message_id,guild_id,channel_id,deleted_at,deletion_reason) "+
      "VALUES($1,$2,$3,$4,$5) ON CONFLICT(message_id) DO NOTHING RETURNING message_id",
      [row.message_id,row.guild_id,row.channel_id,observedAt,reason],
    );
    if(inserted.rows.length){
      await emitDiscordObservation(client,erasureObservation(row,reason,observedAt));
      queued++;
    }
  }
  return queued;
}

export async function storeObservation(pool, o, retentionDays, clock=new Date()){
  if(isExpiredObservation(o,retentionDays,clock))return {status:"expired"};
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    // Serialize create/edit/delete races for one globally unique Discord message.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('discord'),hashtext($1))",[o.messageId]);
    const previous=await client.query(
      "SELECT guild_id,channel_id,deleted_at,revision_at,content_sha256 "+
      "FROM discord_messages WHERE message_id=$1 FOR UPDATE",[o.messageId]);
    const old=previous.rows[0]??null;
    if(old&&(old.guild_id!==o.guildId||old.channel_id!==o.channelId))
      throw new Error("Discord message identity reused in another guild/channel");
    const tombstones=await client.query(
      "SELECT guild_id,channel_id FROM discord_message_tombstones WHERE message_id=$1 FOR UPDATE",
      [o.messageId],
    );
    const tombstone=tombstones.rows[0]??null;
    if(tombstone&&(tombstone.guild_id!==o.guildId||tombstone.channel_id!==o.channelId))
      throw new Error("Discord tombstone identity reused in another guild/channel");
    if(tombstone&&o.kind!=="deleted"){
      await client.query("COMMIT");
      return {status:"tombstoned"};
    }
    if(old?.deleted_at&&o.kind!=="deleted"){
      await client.query(
        "INSERT INTO discord_message_tombstones "+
        "(message_id,guild_id,channel_id,deleted_at,deletion_reason) "+
        "VALUES($1,$2,$3,$4,'deleted') ON CONFLICT(message_id) DO NOTHING",
        [o.messageId,old.guild_id,old.channel_id,old.deleted_at],
      );
      await client.query(
        "UPDATE discord_messages SET content=NULL,content_sha256=NULL,author_id=NULL WHERE message_id=$1",
        [o.messageId],
      );
      await client.query(
        "UPDATE discord_message_revisions SET content=NULL,content_sha256=NULL WHERE message_id=$1",
        [o.messageId],
      );
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
        "INSERT INTO discord_message_tombstones "+
        "(message_id,guild_id,channel_id,deleted_at,deletion_reason) "+
        "VALUES($1,$2,$3,$4,$5) ON CONFLICT(message_id) DO UPDATE SET "+
        "deleted_at=LEAST(discord_message_tombstones.deleted_at,EXCLUDED.deleted_at),"+
        "deletion_reason=CASE WHEN EXCLUDED.deletion_reason='deleted' THEN 'deleted' "+
        "ELSE discord_message_tombstones.deletion_reason END",
        [o.messageId,o.guildId,o.channelId,o.observedAt,o.deletionReason??"deleted"]);
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
    if(!stale)await emitDiscordObservation(client,o);
    await client.query("COMMIT");
    return {status:stale?"stale":o.kind==="deleted"?"deleted":"stored"};
  }catch(e){await client.query("ROLLBACK");throw e}
  finally{client.release()}
}

export async function purgeExpired(pool,allowed,{allowEmpty=false}={}){
  // Revocation and retention emit durable erasure tombstones BEFORE local rows
  // are removed. The same transaction contains the source Outbox inserts.
  if(!(allowed instanceof Map)||(!allowEmpty&&allowed.size===0))throw new Error("No authorized channels");
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    let removed=0;
    let tombstonesQueued=0;
    const authorized=[...allowed.entries()].map(([channelId,permission])=>{
      requireRetention(permission.retentionDays);
      if(!permission.guildId)throw new Error("Authorized channel is missing its guild identity");
      return {channelId,guildId:String(permission.guildId),retentionDays:permission.retentionDays};
    });
    const channelIds=authorized.map(item=>item.channelId);
    const guildIds=authorized.map(item=>item.guildId);

    const revokedRows=await client.query(
      "SELECT message_id,guild_id,channel_id FROM discord_messages m "+
      "WHERE m.deleted_at IS NULL AND NOT EXISTS ("+
      "SELECT 1 FROM unnest($1::text[],$2::text[]) AS a(channel_id,guild_id) "+
      "WHERE a.channel_id=m.channel_id AND a.guild_id=m.guild_id)",
      [channelIds,guildIds],
    );
    tombstonesQueued+=await enqueueErasureTombstones(client,revokedRows.rows,"channel_revoked");
    if(revokedRows.rows.length){
      const ids=revokedRows.rows.map(row=>row.message_id);
      const revisions=await client.query(
        "DELETE FROM discord_message_revisions WHERE message_id=ANY($1::text[])",[ids]);
      const messages=await client.query(
        "DELETE FROM discord_messages WHERE message_id=ANY($1::text[])",[ids]);
      removed+=revisions.rowCount+messages.rowCount;
    }
    await client.query(
      "DELETE FROM discord_backfill_cursors c WHERE NOT EXISTS ("+
      "SELECT 1 FROM unnest($1::text[],$2::text[]) AS a(channel_id,guild_id) "+
      "WHERE a.channel_id=c.channel_id AND a.guild_id=c.guild_id)",
      [channelIds,guildIds],
    );
    await client.query(
      "DELETE FROM discord_recovery_checks c WHERE NOT EXISTS ("+
      "SELECT 1 FROM unnest($1::text[],$2::text[]) AS a(channel_id,guild_id) "+
      "WHERE a.channel_id=c.channel_id AND a.guild_id=c.guild_id)",
      [channelIds,guildIds],
    );

    for(const item of authorized){
      const expired=await client.query(
        "SELECT message_id,guild_id,channel_id FROM discord_messages "+
        "WHERE channel_id=$1 AND guild_id=$2 AND deleted_at IS NULL "+
        "AND COALESCE(occurred_at,observed_at)<NOW()-($3::integer*INTERVAL '1 day')",
        [item.channelId,item.guildId,item.retentionDays],
      );
      tombstonesQueued+=await enqueueErasureTombstones(client,expired.rows,"retention_expired");
      if(expired.rows.length){
        const ids=expired.rows.map(row=>row.message_id);
        const revisions=await client.query(
          "DELETE FROM discord_message_revisions WHERE message_id=ANY($1::text[])",[ids]);
        const messages=await client.query(
          "DELETE FROM discord_messages WHERE message_id=ANY($1::text[])",[ids]);
        removed+=revisions.rowCount+messages.rowCount;
      }
    }
    await client.query("COMMIT");
    return {rowsErased:removed,tombstonesQueued};
  }catch(e){await client.query("ROLLBACK");throw e}
  finally{client.release()}
}

export async function getRecoveryBaseline(pool,channelId){
  // A previous bounded scan may have exhausted its page budget; preserve that
  // unresolved low watermark across restarts rather than concealing a gap behind
  // newly ingested Gateway messages.
  const pending=await pool.query(
    "SELECT baseline_message_id FROM discord_recovery_checks "+
    "WHERE channel_id=$1 AND status IN ('gap_unresolved','failed') AND resolved_at IS NULL "+
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
        "AND status IN ('gap_unresolved','failed') AND resolved_at IS NULL",
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
