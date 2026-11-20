import test from "node:test";
import assert from "node:assert/strict";
import {normalizeMessage,validateAuthorization} from "../src/events.mjs";
import {IngressSpool} from "../src/ingress-spool.mjs";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomBytes} from "node:crypto";
import {installSchema,storeObservation,purgeExpired,getRecoveryBaseline,recordRecoveryCheck,recordCoverageFailure,findUserMessageIds,eraseUserMessages,assertNoUnattributedRetainedContent} from "../src/storage.mjs";

const URL=process.env.DISCORD_TEST_DATABASE_URL;
const guildId="123456789012345678";
const channelId="223456789012345678";
const otherChannel="523456789012345678";
const messageId="323456789012345678";
const allowed=validateAuthorization({version:2,mode:"collect",guilds:[{
  guild_id:guildId,channel_ids:[channelId,otherChannel],retention_days:30,
  policy_review_reference:"test",policy_review_expires_at:"2026-12-19T00:00:00Z",
  community_permission_reference:"test",community_permission_expires_at:"2026-12-19T00:00:00Z",
  reviewed_by:"ci"
}]});

test("storage boundary rejects authorless observations even when normalization is bypassed",async()=>{
  const invalid={
    kind:"observed",messageId,guildId,channelId,authorId:null,
    occurredAt:new Date().toISOString(),observedAt:new Date().toISOString(),
    editedAt:null,revisionAt:new Date().toISOString(),content:"must not be retained",
    contentSha:"a".repeat(64),revisionKey:"b".repeat(64),
  };
  await assert.rejects(
    storeObservation({connect:()=>{throw new Error("database must not be touched")}},invalid,30),
    /Invalid Discord author Snowflake/,
  );
});

test("source schema upgrades an old tombstone reason constraint and remains idempotent",{skip:!URL},async()=>{
  const {default:pg}=await import("pg");
  const suffix=randomBytes(5).toString("hex");
  const schema="discord_legacy_schema_"+suffix;
  const admin=new pg.Client({connectionString:URL});
  let pool;
  await admin.connect();
  try{
    await admin.query('CREATE SCHEMA "'+schema+'"');
    await admin.query('SET search_path TO "'+schema+'"');
    // Model a database created before user_requested was added to the
    // source-side deletion-reason constraint.
    const legacyDdl=[
      "CREATE TABLE discord_message_tombstones(",
      "message_id TEXT PRIMARY KEY,",
      "guild_id TEXT NOT NULL,",
      "channel_id TEXT NOT NULL,",
      "deleted_at TIMESTAMPTZ NOT NULL,",
      "deletion_reason TEXT NOT NULL CONSTRAINT discord_message_tombstones_deletion_reason_check ",
      "CHECK(deletion_reason IN ('deleted','retention_expired','channel_revoked')),",
      "CHECK(message_id ~ '^[1-9][0-9]{14,21}$' ",
      "AND guild_id ~ '^[1-9][0-9]{14,21}$' ",
      "AND channel_id ~ '^[1-9][0-9]{14,21}$' ",
      "AND message_id::numeric<=18446744073709551615 ",
      "AND guild_id::numeric<=18446744073709551615 ",
      "AND channel_id::numeric<=18446744073709551615)",
      ")",
    ].join("\n");
    await admin.query(legacyDdl);
    pool=new pg.Pool({connectionString:URL,options:"-c search_path="+schema,max:2});
    const before=await pool.query(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint "+
      "WHERE conrelid='discord_message_tombstones'::regclass "+
      "AND conname='discord_message_tombstones_deletion_reason_check'",
    );
    assert.equal(before.rows.length,1);
    assert.ok(!before.rows[0].definition.includes("user_requested"));

    await installSchema(pool);
    await pool.query(
      "INSERT INTO discord_message_tombstones(message_id,guild_id,channel_id,deleted_at,deletion_reason) "+
      "VALUES($1,$2,$3,NOW(),'user_requested')",
      ["923456789012345691",guildId,channelId],
    );
    // Startup runs the source schema on every launch; a second application
    // must neither restore the old CHECK nor create duplicate constraints.
    await installSchema(pool);
    await pool.query(
      "INSERT INTO discord_message_tombstones(message_id,guild_id,channel_id,deleted_at,deletion_reason) "+
      "VALUES($1,$2,$3,NOW(),'user_requested')",
      ["923456789012345692",guildId,channelId],
    );
    const constraints=await pool.query(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint "+
      "WHERE conrelid='discord_message_tombstones'::regclass "+
      "AND conname='discord_message_tombstones_deletion_reason_check'",
    );
    assert.equal(constraints.rows.length,1);
    assert.ok(constraints.rows[0].definition.includes("user_requested"));
    const rows=await pool.query(
      "SELECT COUNT(*)::int AS n FROM discord_message_tombstones WHERE deletion_reason='user_requested'",
    );
    assert.equal(rows.rows[0].n,2);
  }finally{
    if(pool)await pool.end();
    await admin.query("SET search_path TO public");
    await admin.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
    await admin.end();
  }
});

test("only one Discord Collector can hold the source database advisory lock",{skip:!URL},async()=>{
  const {default:pg}=await import("pg");
  const pool=new pg.Pool({connectionString:URL,max:2});
  const first=await pool.connect();
  const second=await pool.connect();
  const lockSql="SELECT pg_try_advisory_lock(hashtextextended('potapoff:discord-collector:singleton',0)) AS acquired";
  const unlockSql="SELECT pg_advisory_unlock(hashtextextended('potapoff:discord-collector:singleton',0))";
  try{
    assert.equal((await first.query(lockSql)).rows[0].acquired,true);
    assert.equal((await second.query(lockSql)).rows[0].acquired,false);
    await first.query(unlockSql);
    assert.equal((await second.query(lockSql)).rows[0].acquired,true);
    await second.query(unlockSql);
  }finally{
    first.release();
    second.release();
    await pool.end();
  }
});

test("durable spool replay after source commit does not duplicate the transactional outbox",{skip:!URL},async()=>{
  const {default:pg}=await import("pg");
  const pool=new pg.Pool({connectionString:URL,max:2});
  const directory=mkdtempSync(join(tmpdir(),"potapoff-discord-spool-integration-"));
  const key=randomBytes(32);
  const messageId="923456789012345678";
  let eventKey=null;
  let spool;
  try{
    await installSchema(pool);
    spool=new IngressSpool({directory,key}).open();
    const now=new Date();
    const createdAt=new Date(now.getTime()-60*60*1000);
    const message={id:messageId,guildId,channelId,author:{id:"423456789012345678"},
      content:"replay-safe Discord source event",createdAt,editedAt:null};
    const snapshot={
      kind:"observed",messageId,guildId,channelId,authorId:message.author.id,
      content:message.content,createdAt:createdAt.toISOString(),editedAt:null,
      receivedAt:now.toISOString(),
    };
    spool.append(snapshot);
    const [first]=spool.listPending();
    const observation=normalizeMessage(message,"observed",snapshot.receivedAt,guildId);
    eventKey=["discord:message",channelId,messageId,observation.revisionKey].join(":");
    assert.equal((await storeObservation(pool,observation,30)).status,"stored");
    // Simulate a hard crash after PostgreSQL COMMIT but before local ACK.
    spool.close();
    spool=new IngressSpool({directory,key}).open();
    const [replayed]=spool.listPending();
    assert.equal(replayed.event.messageId,messageId);
    assert.equal((await storeObservation(pool,observation,30)).status,"stored");
    const rows=await pool.query(
      "SELECT COUNT(*)::int AS n FROM outbox_events WHERE source_system='discord' AND event_key=$1",
      [eventKey]);
    assert.equal(rows.rows[0].n,1,"replaying an unacknowledged spool file must not duplicate the source event");
    assert.equal(spool.ack(first.sequence),true);
    spool.flushAcks();
    assert.equal(spool.pendingCount,0);
  }finally{
    try{spool?.close()}catch{}
    if(eventKey){
      await pool.query("DELETE FROM outbox_events WHERE source_system='discord' AND event_key=$1",[eventKey]).catch(()=>{});
    }
    await pool.query("DELETE FROM discord_message_revisions WHERE message_id=$1",[messageId]).catch(()=>{});
    await pool.query("DELETE FROM discord_messages WHERE message_id=$1",[messageId]).catch(()=>{});
    await pool.end();
    rmSync(directory,{recursive:true,force:true});
  }
});

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
    let queued=await pool.query("SELECT event_kind,event_key,payload FROM outbox_events WHERE source_system='discord' AND event_key LIKE $1 ORDER BY id",["discord:message:"+channelId+":"+messageId+":%"]);
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
    queued=await pool.query("SELECT event_kind,event_key,payload FROM outbox_events WHERE source_system='discord' AND event_key LIKE $1 ORDER BY id",["discord:message:"+channelId+":"+messageId+":%"]);
    assert.equal(queued.rows.length,2,"stale REST history must not create a fresh source event");
    assert.equal(queued.rows[1].event_kind,"message_edited");
    assert.equal(queued.rows[1].payload.contentSha256,edited.contentSha);
    const active=await pool.query("SELECT content,revision_at FROM discord_messages WHERE message_id=$1",[messageId]);
    assert.equal(active.rows[0].content,"edited message");
    assert.equal(new Date(active.rows[0].revision_at).getTime(),editedAt.getTime());
    const deletePartial={id:messageId,channelId};
    const deletion=normalizeMessage(deletePartial,"deleted",now.toISOString(),guildId);
    assert.equal((await storeObservation(pool,deletion,30)).status,"deleted");
    queued=await pool.query("SELECT event_kind,payload FROM outbox_events WHERE source_system='discord' AND event_key LIKE $1 ORDER BY id",["discord:message:"+channelId+":"+messageId+":%"]);
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
    await pool.query("CREATE OR REPLACE FUNCTION fail_discord_outbox_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture outbox failure'; END $$");
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

test("explicit erasure-only mode purges every source message and emits tombstones",{skip:!URL},async()=>{
  const {default:pg}=await import("pg");
  const pool=new pg.Pool({connectionString:URL,max:2});
  const messageId="923456789012345679";
  const eventKeyPattern="discord:message:"+channelId+":"+messageId+":%";
  try{
    await installSchema(pool);
    const now=new Date();
    const createdAt=new Date(now.getTime()-60*60*1000);
    const message={id:messageId,guildId,channelId,author:{id:"423456789012345678"},
      content:"must be erased when consent is revoked",createdAt,editedAt:null};
    const observation=normalizeMessage(message,"observed",now.toISOString(),guildId);
    await storeObservation(pool,observation,30);
    await assert.rejects(purgeExpired(pool,new Map()),/No authorized channels/);
    const result=await purgeExpired(pool,new Map(),{allowEmpty:true});
    assert.ok(result.tombstonesQueued>=1);
    const remaining=await pool.query("SELECT COUNT(*)::int AS n FROM discord_messages WHERE message_id=$1",[messageId]);
    assert.equal(remaining.rows[0].n,0);
    const tombstone=await pool.query(
      "SELECT deletion_reason FROM discord_message_tombstones WHERE message_id=$1",[messageId]);
    assert.equal(tombstone.rows[0].deletion_reason,"channel_revoked");
    const deletion=await pool.query(
      "SELECT payload->>'deletionReason' AS reason FROM outbox_events "+
      "WHERE source_system='discord' AND event_kind='message_deleted' AND event_key LIKE $1",
      [eventKeyPattern]);
    assert.deepEqual(deletion.rows.map(row=>row.reason),["channel_revoked"]);
  }finally{
    await pool.query("DELETE FROM outbox_events WHERE source_system='discord' AND event_key LIKE $1",[eventKeyPattern]).catch(()=>{});
    await pool.query("DELETE FROM discord_message_tombstones WHERE message_id=$1",[messageId]).catch(()=>{});
    await pool.query("DELETE FROM discord_message_revisions WHERE message_id=$1",[messageId]).catch(()=>{});
    await pool.query("DELETE FROM discord_messages WHERE message_id=$1",[messageId]).catch(()=>{});
    await pool.end();
  }
});

test("source transaction refuses to persist an event after its authorization lease expired",{skip:!URL},async()=>{
  const {default:pg}=await import("pg");
  const pool=new pg.Pool({connectionString:URL,max:2});
  const messageId="923456789012345680";
  try{
    await installSchema(pool);
    const now=new Date();
    const observation=normalizeMessage({
      id:messageId,guildId,channelId,author:{id:"423456789012345680"},
      content:"must not be persisted after expiry",createdAt:now,editedAt:null,
    },"observed",now.toISOString(),guildId);
    const result=await storeObservation(pool,observation,30,new Date(),"2026-11-18T00:00:00.000Z");
    assert.equal(result.status,"authorization-expired");
    const rows=await pool.query("SELECT COUNT(*)::int AS n FROM discord_messages WHERE message_id=$1",[messageId]);
    assert.equal(rows.rows[0].n,0);
    const outbox=await pool.query(
      "SELECT COUNT(*)::int AS n FROM outbox_events WHERE source_system='discord' AND event_key LIKE $1",
      ["discord:message:"+channelId+":"+messageId+":%"]);
    assert.equal(outbox.rows[0].n,0);
  }finally{
    await pool.query("DELETE FROM outbox_events WHERE source_system='discord' AND event_key LIKE $1",
      ["discord:message:"+channelId+":"+messageId+":%"]).catch(()=>{});
    await pool.query("DELETE FROM discord_message_revisions WHERE message_id=$1",[messageId]).catch(()=>{});
    await pool.query("DELETE FROM discord_messages WHERE message_id=$1",[messageId]).catch(()=>{});
    await pool.end();
  }
});

test("unhydratable message coverage is recorded before acknowledgement and expires with retention",{skip:!URL},async()=>{
  const {default:pg}=await import("pg");
  const pool=new pg.Pool({connectionString:URL,max:2});
  const coverageMessageId="923456789012345681";
  const receivedAt=new Date(Date.now()-31*24*60*60*1000).toISOString();
  try{
    await installSchema(pool);
    const event={kind:"edited",guildId,channelId,messageId:coverageMessageId,
      authorId:"423456789012345681",receivedAt};
    await recordCoverageFailure(pool,event,365);
    await recordCoverageFailure(pool,event,365);
    const recorded=await pool.query(
      "SELECT guild_id,channel_id,message_id,author_id,event_kind,failure_code FROM discord_coverage_failures WHERE message_id=$1",
      [coverageMessageId],
    );
    assert.deepEqual(recorded.rows,[{
      guild_id:guildId,channel_id:channelId,message_id:coverageMessageId,
      author_id:"423456789012345681",event_kind:"edited",failure_code:"message_not_found",
    }],"duplicate replay must not duplicate a durable coverage failure");
    const purge=await purgeExpired(pool,allowed);
    assert.equal(purge.coverageFailuresErased,1);
    const remaining=await pool.query(
      "SELECT COUNT(*)::int AS n FROM discord_coverage_failures WHERE message_id=$1",
      [coverageMessageId],
    );
    assert.equal(remaining.rows[0].n,0);
  }finally{
    await pool.query("DELETE FROM discord_coverage_failures WHERE message_id=$1",[coverageMessageId]).catch(()=>{});
    await pool.end();
  }
});

test("source observation rechecks the current authorization lease inside its transaction",{skip:!URL},async()=>{
  const {default:pg}=await import("pg");
  const pool=new pg.Pool({connectionString:URL,max:2});
  const id="923456789012345698";
  try{
    await installSchema(pool);
    const observation=normalizeMessage({
      id,guildId,channelId,author:{id:"423456789012345697"},
      content:"must not survive a concurrent channel revocation",
      createdAt:new Date(),editedAt:null,
    },"observed",new Date().toISOString(),guildId);
    const result=await storeObservation(
      pool,observation,30,new Date(),allowed.get(channelId).expiresAt,()=>false,
    );
    assert.deepEqual(result,{status:"not-authorized"});
    const rows=await pool.query(
      "SELECT COUNT(*)::int AS n FROM discord_messages WHERE message_id=$1",[id],
    );
    assert.equal(rows.rows[0].n,0);
    const outbox=await pool.query(
      "SELECT COUNT(*)::int AS n FROM outbox_events WHERE source_system='discord' AND event_key LIKE $1",
      ["discord:message:"+channelId+":"+id+":%"],
    );
    assert.equal(outbox.rows[0].n,0);
  }finally{
    await pool.query("DELETE FROM outbox_events WHERE source_system='discord' AND event_key LIKE $1",
      ["discord:message:"+channelId+":"+id+":%"]).catch(()=>{});
    await pool.query("DELETE FROM discord_message_revisions WHERE message_id=$1",[id]).catch(()=>{});
    await pool.query("DELETE FROM discord_messages WHERE message_id=$1",[id]).catch(()=>{});
    await pool.query("DELETE FROM discord_message_tombstones WHERE message_id=$1",[id]).catch(()=>{});
    await pool.end();
  }
});

test("user erasure refuses to claim completion while legacy authorless message or revision content remains",{skip:!URL},async()=>{
  const {default:pg}=await import("pg");
  const pool=new pg.Pool({connectionString:URL,max:2});
  const orphanId=(9_000_000_000_000_000_000n+
    BigInt(randomBytes(4).readUInt32BE(0))*1_000_000_000n+
    BigInt(randomBytes(4).readUInt32BE(0))).toString();
  const revisionKey="d".repeat(64);
  try{
    await installSchema(pool);
    await pool.query(
      "INSERT INTO discord_messages "+
      "(message_id,guild_id,channel_id,author_id,occurred_at,observed_at,content,content_sha256) "+
      "VALUES($1,$2,$3,NULL,NOW(),NOW(),'legacy unattributed content',$4)",
      [orphanId,guildId,channelId,revisionKey],
    );
    await pool.query(
      "INSERT INTO discord_message_revisions "+
      "(message_id,guild_id,channel_id,revision_key,event_kind,observed_at,content_sha256,content) "+
      "VALUES($1,$2,$3,$4,'observed',NOW(),$5,'legacy unattributed revision')",
      [orphanId,guildId,channelId,revisionKey,revisionKey],
    );
    await assert.rejects(
      assertNoUnattributedRetainedContent(pool),
      /unattributed_discord_content_requires_operator_review/,
    );
    await assert.rejects(
      eraseUserMessages(pool,"423456789012345689"),
      /unattributed_discord_content_requires_operator_review/,
      "the erasure transaction itself must fail closed if a caller skips the CLI preflight",
    );
    const stillPresent=await pool.query(
      "SELECT COUNT(*)::int AS n FROM discord_messages WHERE message_id=$1 AND content IS NOT NULL",
      [orphanId],
    );
    assert.equal(stillPresent.rows[0].n,1);
    await pool.query(
      "UPDATE discord_messages SET content=NULL,content_sha256=NULL WHERE message_id=$1",
      [orphanId],
    );
    await assert.rejects(
      assertNoUnattributedRetainedContent(pool),
      /unattributed_discord_content_requires_operator_review/,
      "revision payloads must also be checked when the current message row is already scrubbed",
    );
    await pool.query(
      "UPDATE discord_message_revisions SET content=NULL,content_sha256=NULL WHERE message_id=$1",
      [orphanId],
    );
    await assert.doesNotReject(assertNoUnattributedRetainedContent(pool));
  }finally{
    await pool.query("DELETE FROM discord_message_revisions WHERE message_id=$1",[orphanId]).catch(()=>{});
    await pool.query("DELETE FROM discord_messages WHERE message_id=$1",[orphanId]).catch(()=>{});
    await pool.end();
  }
});

test("user-requested erasure removes all author content and emits content-free tombstones",{skip:!URL},async()=>{
  const {default:pg}=await import("pg");
  const pool=new pg.Pool({connectionString:URL,max:2});
  const authorId="423456789012345689";
  const ids=["923456789012345682","923456789012345683"];
  try{
    await installSchema(pool);
    const now=new Date();
    for(let i=0;i<ids.length;i++){
      const message={
        id:ids[i],guildId,channelId:i===0?channelId:otherChannel,
        author:{id:authorId},content:"private author message",
        createdAt:new Date(now.getTime()-60*60*1000),editedAt:null,
      };
      const observation=normalizeMessage(message,"observed",now.toISOString(),guildId);
      assert.equal((await storeObservation(pool,observation,30)).status,"stored");
    }
    await recordCoverageFailure(pool,{
      kind:"edited",guildId,channelId,messageId:ids[0],authorId,
      receivedAt:now.toISOString(),
    },30);
    assert.deepEqual(await findUserMessageIds(pool,authorId),ids.slice().sort());
    await assert.rejects(eraseUserMessages(pool,Number(authorId)),/Invalid Discord author Snowflake/);
    const result=await eraseUserMessages(pool,authorId);
    assert.deepEqual(result,{
      messagesErased:2,revisionsErased:2,tombstonesQueued:2,coverageFailuresErased:1,
    });
    const remaining=await pool.query(
      "SELECT COUNT(*)::int AS n FROM discord_messages WHERE author_id=$1",[authorId]);
    assert.equal(remaining.rows[0].n,0);
    const revisions=await pool.query(
      "SELECT COUNT(*)::int AS n FROM discord_message_revisions WHERE message_id=ANY($1::text[])",[ids]);
    assert.equal(revisions.rows[0].n,0);
    const tombstones=await pool.query(
      "SELECT message_id,deletion_reason FROM discord_message_tombstones WHERE message_id=ANY($1::text[]) ORDER BY message_id",[ids]);
    assert.deepEqual(tombstones.rows,ids.map(message_id=>({message_id,deletion_reason:"user_requested"})));
    const outbox=await pool.query(
      "SELECT payload->>'deletionReason' AS reason,payload::text AS payload FROM outbox_events "+
      "WHERE source_system='discord' AND event_kind='message_deleted' AND event_key LIKE ANY($1::text[])",
      [ids.map(id=>"discord:message:%:"+id+":%")]);
    assert.equal(outbox.rows.length,2);
    for(const row of outbox.rows){
      assert.equal(row.reason,"user_requested");
      assert.ok(!row.payload.includes(authorId));
      assert.ok(!row.payload.includes("private author message"));
    }
    const replay=normalizeMessage({
      id:ids[0],guildId,channelId,author:{id:authorId},content:"late replay",
      createdAt:new Date(now.getTime()-60*60*1000),editedAt:null,
    },"observed",now.toISOString(),guildId);
    assert.equal((await storeObservation(pool,replay,30)).status,"tombstoned");
    const laterDelete=normalizeMessage({id:ids[0],channelId},"deleted",
      new Date(now.getTime()+60_000).toISOString(),guildId);
    assert.equal((await storeObservation(pool,laterDelete,30)).status,"deleted");
    const preservedSourceReason=await pool.query(
      "SELECT deletion_reason FROM discord_message_tombstones WHERE message_id=$1",[ids[0]],
    );
    assert.equal(preservedSourceReason.rows[0].deletion_reason,"user_requested",
      "a later ordinary Discord delete must not overwrite the DSAR reason");
  }finally{
    await pool.query("DELETE FROM outbox_events WHERE source_system='discord' AND event_key LIKE ANY($1::text[])",
      [ids.map(id=>"discord:message:%:"+id+":%")]).catch(()=>{});
    await pool.query("DELETE FROM discord_message_tombstones WHERE message_id=ANY($1::text[])",[ids]).catch(()=>{});
    await pool.query("DELETE FROM discord_coverage_failures WHERE message_id=ANY($1::text[])",[ids]).catch(()=>{});
    await pool.query("DELETE FROM discord_message_revisions WHERE message_id=ANY($1::text[])",[ids]).catch(()=>{});
    await pool.query("DELETE FROM discord_messages WHERE message_id=ANY($1::text[])",[ids]).catch(()=>{});
    await pool.end();
  }
});
