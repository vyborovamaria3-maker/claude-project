import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {dirname,resolve} from "node:path";
const here=dirname(fileURLToPath(import.meta.url));

export async function installSchema(pool){
  const sql=await readFile(resolve(here,"../schema.sql"),"utf8");
  await pool.query(sql);
}

export async function storeObservation(pool, o){
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO discord_message_revisions "+
      "(message_id,guild_id,channel_id,revision_key,event_kind,observed_at,content_sha256,content) "+
      "VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING",
      [o.messageId,o.guildId,o.channelId,o.revisionKey,o.kind,o.observedAt,o.contentSha,o.content]);
    if(o.kind==="deleted"){
      await client.query(
        "INSERT INTO discord_messages "+
        "(message_id,guild_id,channel_id,author_id,occurred_at,observed_at,edited_at,content,content_sha256,deleted_at) "+
        "VALUES($1,$2,$3,NULL,NULL,$4,NULL,NULL,NULL,$4) "+
        "ON CONFLICT(message_id) DO UPDATE SET "+
        "deleted_at=COALESCE(discord_messages.deleted_at,EXCLUDED.deleted_at),"+
        "content=NULL,content_sha256=NULL,"+
        "observed_at=GREATEST(discord_messages.observed_at,EXCLUDED.observed_at)",
        [o.messageId,o.guildId,o.channelId,o.observedAt]);
      await client.query(
        "UPDATE discord_message_revisions SET content=NULL,content_sha256=NULL WHERE message_id=$1",
        [o.messageId]);
    }else{
      await client.query(
        "INSERT INTO discord_messages "+
        "(message_id,guild_id,channel_id,author_id,occurred_at,observed_at,edited_at,content,content_sha256) "+
        "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) "+
        "ON CONFLICT(message_id) DO UPDATE SET "+
        "author_id=COALESCE(EXCLUDED.author_id,discord_messages.author_id),"+
        "occurred_at=COALESCE(EXCLUDED.occurred_at,discord_messages.occurred_at),"+
        "observed_at=EXCLUDED.observed_at,edited_at=EXCLUDED.edited_at,"+
        "content=EXCLUDED.content,content_sha256=EXCLUDED.content_sha256 "+
        "WHERE discord_messages.deleted_at IS NULL "+
        "AND EXCLUDED.observed_at>=discord_messages.observed_at",
        [o.messageId,o.guildId,o.channelId,o.authorId,o.occurredAt,o.observedAt,
         o.editedAt,o.content,o.contentSha]);
      // Late create/edit must never restore previously deleted raw content to revisions.
      await client.query(
        "UPDATE discord_message_revisions SET content=NULL,content_sha256=NULL "+
        "WHERE message_id=$1 AND EXISTS(SELECT 1 FROM discord_messages WHERE message_id=$1 AND deleted_at IS NOT NULL)",
        [o.messageId]);
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
