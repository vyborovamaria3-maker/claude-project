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
    const now=new Date();
    const createdAt=new Date(now.getTime()-60*60*1000);
    const editedAt=new Date(now.getTime()-30*60*1000);
    const base={id:messageId,guildId,channelId,author:{id:"423456789012345678"},
      createdAt,editedAt:null,content:"first message"};
    const origin=normalizeMessage(base,"observed",now.toISOString());
    assert.equal((await storeObservation(pool,origin,30)).status,"stored");
    assert.equal((await storeObservation(pool,origin,30)).status,"stored");
    let queued=await pool.query("SELECT event_kind,event_key,payload FROM outbox_events WHERE source_system='discord' ORDER BY id");
    assert.equal(queued.rows.length,1,"duplicate observations must be idempotent in the source outbox");
    assert.equal(queued.rows[0].event_kind,"message_observed");
    assert.equal(queued.rows[0].payload.channelId,channelId);
    assert.equal(queued.rows[0].payload.contentSha256,origin.contentSha);
    assert.equal("content" in queued.rows[0].payload,false);
    assert.equal("authorId" in queued.rows[0].payload,false);
    const edited=normalizeMessage({...base,editedAt,content:"edited message"},"edited",now.toISOString());
    assert.equal((await storeObservation(pool,edited,30)).status,"stored");
    const stale=normalizeMessage(base,"observed",new Date(now.getTime()+1000).toISOString());
    assert.equal((await storeObservation(pool,stale,30)).status,"stale");
    queued=await pool.query("SELECT event_kind,event_key,payload FROM outbox_events WHERE source_system='discord' ORDER BY id");
    assert.equal(queued.rows.length,2,"stale REST history must not create a fresh source event");
    assert.equal(queued.rows[1].event_kind,"message_edited");
    assert.equal(queued.rows[1].payload.contentSha256,edited.contentSha);
    const active=await pool.query("SELECT content,revision_at FROM discord_messages WHERE message_id=$1",[messageId]);
    assert.equal(active.rows[0].content,"edited message");
    assert.equal(new Date(active.rows[0].revision_at).getTime(),editedAt.getTime());
    const deletePartial={id:messageId,channelId};
    const deletion=normalizeMessage(deletePartial,"deleted",now.toISOString(),guildId);
    assert.equal((await storeObservation(pool,deletion,30)).status,"deleted");
    queued=await pool.query("SELECT event_kind,payload FROM outbox_events WHERE source_system='discord' ORDER BY id");
    assert.equal(queued.rows.length,3);
    assert.equal(queued.rows[2].event_kind,"message_deleted");
    assert.equal(queued.rows[2].payload.contentErased,true);
    assert.equal(queued.rows[2].payload.contentSha256,null);
    assert.equal(queued.rows[2].payload.deletionReason,"deleted");
    assert.equal("content" in queued.rows[2].payload,false);
    assert.equal("authorId" in queued.rows[2].payload,false);
    assert.equal((await storeObservation(pool,edited,30)).status,"tombstoned");
    const erased=await pool.query("SELECT content,content_sha256,author_id,deleted_at FROM discord_messages WHERE message_id=$1",[messageId]);
    assert.equal(erased.rows[0].content,null);
    assert.equal(erased.rows[0].author_id,null);
    assert.ok(erased.rows[0].deleted_at);
    const sourceDeleteTombstone=await pool.query(
      "SELECT deletion_reason FROM discord_message_tombstones WHERE message_id=$1",[messageId]);
    assert.equal(sourceDeleteTombstone.rows[0].deletion_reason,"deleted");
    const leaked=await pool.query("SELECT COUNT(*)::int AS n FROM discord_message_revisions WHERE message_id=$1 AND content IS NOT NULL",[messageId]);
    assert.equal(leaked.rows[0].n,0);
    // A source removed from the allowlist is erased on the next sweep.
    const second=normalizeMessage({...base,id:"623456789012345678",channelId:otherChannel,content:"revocable"},"observed");
    await storeObservation(pool,second,30);
    const oldBase={...base,id:"823456789012345678",
      createdAt:new Date(now.getTime()-31*24*60*60*1000),content:"expired"};
    const oldObservation=normalizeMessage(oldBase,"observed",now.toISOString());
    assert.equal((await storeObservation(pool,oldObservation,365)).status,"stored");
    const reduced=new Map([[channelId,{...allowed.get(channelId),retentionDays:30}]]);
    const purge=await purgeExpired(pool,reduced);
    assert.equal(purge.tombstonesQueued,2,"revocation and retention must both enqueue erasure events");
    const removed=await pool.query("SELECT COUNT(*)::int AS n FROM discord_messages WHERE channel_id=$1",[otherChannel]);
    assert.equal(removed.rows[0].n,0);
    const sourceTombstones=await pool.query(
      "SELECT message_id,deletion_reason FROM discord_message_tombstones WHERE message_id=ANY($1::text[]) ORDER BY message_id",
      [["623456789012345678","823456789012345678"]]);
    assert.deepEqual(sourceTombstones.rows,[
      {message_id:"623456789012345678",deletion_reason:"channel_revoked"},
      {message_id:"823456789012345678",deletion_reason:"retention_expired"},
    ]);
    const erasedOutbox=await pool.query(
      "SELECT payload->>'deletionReason' AS reason FROM outbox_events "+
      "WHERE source_system='discord' AND event_kind='message_deleted' AND payload->>'deletionReason' IS NOT NULL "+
      "ORDER BY reason");
    assert.deepEqual(erasedOutbox.rows.map(row=>row.reason),["channel_revoked","deleted","retention_expired"]);
    assert.equal((await storeObservation(pool,second,30)).status,"tombstoned",
      "revoked messages must not be reinserted after local retention purge");
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

    // If the outbox insert fails, the message and revision must roll back too.
    await pool.query("CREATE OR REPLACE FUNCTION fail_discord_outbox_fixture() RETURNS trigger LANGUAGE plpgsql AS $ BEGIN RAISE EXCEPTION 'fixture outbox failure'; END $");
    await pool.query("CREATE TRIGGER fail_discord_outbox_fixture BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION fail_discord_outbox_fixture()");
    const atomic=normalizeMessage({...base,id:"723456789012345678",content:"must roll back"},"observed",now.toISOString());
    await assert.rejects(storeObservation(pool,atomic,30),/fixture outbox failure/);
    const rolledBack=await pool.query("SELECT (SELECT count(*) FROM discord_messages WHERE message_id=$1)::int AS messages,(SELECT count(*) FROM discord_message_revisions WHERE message_id=$1)::int AS revisions",[atomic.messageId]);
    assert.deepEqual(rolledBack.rows[0],{messages:0,revisions:0});
    await pool.query("DROP TRIGGER fail_discord_outbox_fixture ON outbox_events");
    await pool.query("DROP FUNCTION fail_discord_outbox_fixture()");
  }finally{
    await pool.end();
  }
});
