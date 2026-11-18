import test from "node:test";
import assert from "node:assert/strict";
import {normalizeMessage,validateAuthorization} from "../src/events.mjs";
import {installSchema,storeObservation,purgeExpired,getRecoveryBaseline,recordRecoveryCheck} from "../src/storage.mjs";
import {emitDiscordOutbox} from "../src/outbox.mjs";

const URL=process.env.DISCORD_TEST_DATABASE_URL;
const guildId="123456789012345678";
const channelId="223456789012345678";
const otherChannel="523456789012345678";
const messageId="323456789012345678";
const allowed=validateAuthorization({guilds:[{
  guild_id:guildId,channel_ids:[channelId,otherChannel],retention_days:30,
  policy_review_reference:"test",community_permission_reference:"test",reviewed_by:"ci"
}]});

test("PostgreSQL revisions, stale history, deletions and revoke/retention", {skip:!URL},async()=>{
  const {default:pg}=await import("pg");
  const pool=new pg.Pool({connectionString:URL,max:2});
  try{
    await installSchema(pool);
    const now=new Date();
    const createdAt=new Date(now.getTime()-60*60*1000);
    const editedAt=new Date(now.getTime()-30*60*1000);
    const base={id:messageId,guildId,channelId,author:{id:"423456789012345678"},
      createdAt,editedAt:null,content:"first message"};
    const origin=normalizeMessage(base,"observed",now.toISOString());
    assert.equal((await storeObservation(pool,origin,30,now,emitDiscordOutbox)).status,"stored");
    assert.equal((await storeObservation(pool,origin,30)).status,"stored");
    const edited=normalizeMessage({...base,editedAt,content:"edited message"},"edited",now.toISOString());
    assert.equal((await storeObservation(pool,edited,30,now,emitDiscordOutbox)).status,"stored");
    const stale=normalizeMessage(base,"observed",new Date(now.getTime()+1000).toISOString());
    assert.equal((await storeObservation(pool,stale,30,now,emitDiscordOutbox)).status,"stale");
    const active=await pool.query("SELECT content,revision_at FROM discord_messages WHERE message_id=$1",[messageId]);
    assert.equal(active.rows[0].content,"edited message");
    assert.equal(new Date(active.rows[0].revision_at).getTime(),editedAt.getTime());
    const deletePartial={id:messageId,channelId};
    const deletion=normalizeMessage(deletePartial,"deleted",now.toISOString(),guildId);
    assert.equal((await storeObservation(pool,deletion,30,now,emitDiscordOutbox)).status,"deleted");
    assert.equal((await storeObservation(pool,edited,30)).status,"tombstoned");
    const erased=await pool.query("SELECT content,content_sha256,author_id,deleted_at FROM discord_messages WHERE message_id=$1",[messageId]);
    assert.equal(erased.rows[0].content,null);
    assert.equal(erased.rows[0].author_id,null);
    assert.ok(erased.rows[0].deleted_at);
    const leaked=await pool.query("SELECT COUNT(*)::int AS n FROM discord_message_revisions WHERE message_id=$1 AND content IS NOT NULL",[messageId]);
    assert.equal(leaked.rows[0].n,0);
    const emitted=await pool.query(
      "SELECT event_kind,created_at,payload FROM outbox_events WHERE source_system='discord' ORDER BY id");
    assert.deepEqual(emitted.rows.map(row=>row.event_kind),[
      "discord_message_observed","discord_message_edited","discord_message_deleted"
    ]);
    for(const row of emitted.rows){
      assert.equal(new Date(row.created_at).toISOString(),row.payload.clocks.emittedAt);
      const serialized=JSON.stringify(row.payload);
      assert.doesNotMatch(serialized,/first message|edited message|423456789012345678|contentSha256|rawPointer|authorId/);
    }
    assert.equal(emitted.rows[1].payload.clocks.occurredAt,editedAt.toISOString());
    assert.equal(emitted.rows[2].payload.clocks.occurredAt,null);
    assert.equal(Object.hasOwn(emitted.rows[2].payload.payload,"timelineEvent"),false);
    // A source removed from the allowlist is erased on the next sweep.
    const second=normalizeMessage({...base,id:"623456789012345678",channelId:otherChannel,content:"revocable"},"observed");
    await storeObservation(pool,second,30,now,emitDiscordOutbox);
    const reduced=new Map([[channelId,allowed.get(channelId)]]);
    await purgeExpired(pool,reduced);
    const removed=await pool.query("SELECT COUNT(*)::int AS n FROM discord_messages WHERE channel_id=$1",[otherChannel]);
    assert.equal(removed.rows[0].n,0);
    const revokedOutbox=await pool.query(
      "SELECT COUNT(*)::int AS n FROM outbox_events WHERE source_system='discord' "+
      "AND payload #>> '{entityRefs,0,canonicalId}'=$1",["discord:channel:"+otherChannel]);
    assert.equal(revokedOutbox.rows[0].n,0);
    const rollbackMessage=normalizeMessage({...base,id:"723456789012345678"}, "observed",now.toISOString());
    await assert.rejects(storeObservation(pool,rollbackMessage,30,now,async()=>{throw new Error("outbox fixture failure")}),/outbox fixture failure/);
    const rolledBack=await pool.query("SELECT COUNT(*)::int AS n FROM discord_messages WHERE message_id=$1",[rollbackMessage.messageId]);
    assert.equal(rolledBack.rows[0].n,0);
    // Incomplete recovery checkpoints must survive service restarts.
    await recordRecoveryCheck(pool,guildId,channelId,messageId,
      {status:"gap_unresolved",pagesScanned:1,messagesProcessed:100});
    assert.equal(await getRecoveryBaseline(pool,channelId),messageId);
    await recordRecoveryCheck(pool,guildId,channelId,messageId,
      {status:"bounded_recovery",pagesScanned:2,messagesProcessed:140});
    const status=await pool.query(
      "SELECT resolved_at FROM discord_recovery_checks WHERE channel_id=$1 "+
      "AND status='gap_unresolved' ORDER BY id DESC LIMIT 1",[channelId]);
    assert.ok(status.rows[0].resolved_at);
  }finally{
    await pool.end();
  }
});
