import test from "node:test";
import assert from "node:assert/strict";
import {normalizeMessage,validateAuthorization} from "../src/events.mjs";
import {installSchema,storeObservation,purgeExpired,getRecoveryBaseline,recordRecoveryCheck} from "../src/storage.mjs";

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
    await pool.query("DELETE FROM discord_message_revisions WHERE message_id=$1",[messageId]);
    await pool.query("DELETE FROM discord_messages WHERE message_id=$1",[messageId]);
    await pool.query("DELETE FROM outbox_events WHERE source_system='discord' AND event_key LIKE $1",
      ["discord:"+guildId+":"+channelId+":"+messageId+":%"]);
    const now=new Date();
    const createdAt=new Date(now.getTime()-60*60*1000);
    const editedAt=new Date(now.getTime()-30*60*1000);
    const base={id:messageId,guildId,channelId,author:{id:"423456789012345678"},
      createdAt,editedAt:null,content:"first message"};
    const origin=normalizeMessage(base,"observed",now.toISOString());
    assert.equal((await storeObservation(pool,origin,30)).status,"stored");
    assert.equal((await storeObservation(pool,origin,30)).status,"stored");
    const edited=normalizeMessage({...base,editedAt,content:"edited message"},"edited",now.toISOString());
    assert.equal((await storeObservation(pool,edited,30)).status,"stored");
    const stale=normalizeMessage(base,"observed",new Date(now.getTime()+1000).toISOString());
    assert.equal((await storeObservation(pool,stale,30)).status,"stale");
    const active=await pool.query("SELECT content,revision_at FROM discord_messages WHERE message_id=$1",[messageId]);
    assert.equal(active.rows[0].content,"edited message");
    assert.equal(new Date(active.rows[0].revision_at).getTime(),editedAt.getTime());
    const deletePartial={id:messageId,channelId};
    const deletion=normalizeMessage(deletePartial,"deleted",now.toISOString(),guildId);
    assert.equal((await storeObservation(pool,deletion,30)).status,"deleted");
    assert.equal((await storeObservation(pool,edited,30)).status,"tombstoned");
    const erased=await pool.query("SELECT content,content_sha256,author_id,deleted_at FROM discord_messages WHERE message_id=$1",[messageId]);
    assert.equal(erased.rows[0].content,null);
    assert.equal(erased.rows[0].author_id,null);
    assert.ok(erased.rows[0].deleted_at);
    const emitted=await pool.query(
      "SELECT event_kind,event_key,payload::text AS payload FROM outbox_events "+
      "WHERE source_system='discord' AND event_key LIKE $1 ORDER BY id",
      ["discord:"+guildId+":"+channelId+":"+messageId+":%"]);
    assert.deepEqual(emitted.rows.map(row=>row.event_kind),
      ["message_observed","message_edited","message_deleted"]);
    for(const row of emitted.rows){
      assert.doesNotMatch(row.payload,/first message|edited message|423456789012345678/);
      const payload=JSON.parse(row.payload);
      assert.equal(payload.registryEvent.sourceSystem,"discord");
      assert.equal(payload.registryEvent.evidenceRef.sourceKind,"discord_message");
      assert.equal(payload.messageRevision.kind,row.event_kind==="message_observed"?"observed":
        row.event_kind==="message_edited"?"edited":"deleted");
    }
    const leaked=await pool.query("SELECT COUNT(*)::int AS n FROM discord_message_revisions WHERE message_id=$1 AND content IS NOT NULL",[messageId]);
    assert.equal(leaked.rows[0].n,0);
    // A source removed from the allowlist is erased on the next sweep.
    const second=normalizeMessage({...base,id:"623456789012345678",channelId:otherChannel,content:"revocable"},"observed");
    await storeObservation(pool,second,30);
    const reduced=new Map([[channelId,allowed.get(channelId)]]);
    await purgeExpired(pool,reduced);
    const removed=await pool.query("SELECT COUNT(*)::int AS n FROM discord_messages WHERE channel_id=$1",[otherChannel]);
    assert.equal(removed.rows[0].n,0);
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
