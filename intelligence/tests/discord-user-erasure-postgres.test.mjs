import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {readFile} from "node:fs/promises";
import pg from "pg";
import {POSTGRES_OUTBOX_DDL,emitPostgres,claimPostgres,ackPostgres,failPostgres} from "@claude-project/event-outbox";
import {runDeliveryBatch} from "../dist/index.js";

const url=process.env.INTELLIGENCE_TEST_DB_URL;
const channelId="223456789012345678";
const messageId="323456789012345678";
const observedAt="2026-11-19T12:00:00.000Z";
const producerVersion="0.1.0";
const revisionA="a".repeat(64);
const revisionB="b".repeat(64);

const source={
  claim:options=>claimPostgres(sourcePool,options),
  ack:event=>ackPostgres(sourcePool,event.id,event.leaseOwner,event.leaseUntil),
  fail:(event,reason,next)=>failPostgres(sourcePool,event.id,event.leaseOwner,event.leaseUntil,reason,next),
};
let sourcePool;

async function emit(payload,eventKind,eventKey){
  const client=await sourcePool.connect();
  try{
    await client.query("BEGIN");
    await emitPostgres(client,{
      sourceSystem:"discord",eventKind,eventKey,
      schemaVersion:"discord-message-v1",payload,
    });
    await client.query("COMMIT");
  }catch(error){
    try{await client.query("ROLLBACK")}catch{}
    throw error;
  }finally{client.release()}
}

test("user-requested Discord deletion retracts prior evidence and persists the reason",{skip:!url},async()=>{
  const suffix=randomBytes(6).toString("hex");
  const sourceSchema="discord_user_source_"+suffix;
  const destinationSchema="discord_user_destination_"+suffix;
  const admin=new pg.Client({connectionString:url});
  let destinationPool;
  await admin.connect();
  try{
    await admin.query('CREATE SCHEMA "'+sourceSchema+'"');
    await admin.query('CREATE SCHEMA "'+destinationSchema+'"');
    await admin.query('SET search_path TO "'+sourceSchema+'"');
    await admin.query(POSTGRES_OUTBOX_DDL);
    sourcePool=new pg.Pool({connectionString:url,options:"-c search_path="+sourceSchema,max:3});

    await admin.query('SET search_path TO "'+destinationSchema+'"');
    for(const name of [
      "001_entity_registry.sql","002_timeline.sql",
      "017_inbox_payload_fingerprint.sql","019_inbox_envelope_fingerprint.sql",
      "022_discord_source_contracts.sql","023_discord_message_tombstones.sql",
      "024_discord_user_requested_erasure.sql",
    ]){
      await admin.query(await readFile(new URL("../migrations/"+name,import.meta.url),"utf8"));
    }
    destinationPool=new pg.Pool({connectionString:url,options:"-c search_path="+destinationSchema,max:3});

    const observedKey="discord:message:"+channelId+":"+messageId+":"+revisionA;
    await emit({
      kind:"observed",channelId,messageId,revisionKey:revisionA,
      observedAt,occurredAt:observedAt,contentSha256:"c".repeat(64),
      producerVersion,
    },"message_observed",observedKey);
    const first=await runDeliveryBatch(source,destinationPool,{
      workerId:"discord-user-erasure-observed",batchSize:1,leaseMs:120000,
    });
    assert.equal(first.delivered,1);
    const before=await destinationPool.query(
      "SELECT COUNT(*)::int AS n FROM entity_evidence WHERE source_system='discord' AND evidence_source_id=$1",
      ["discord:message:"+channelId+":"+messageId],
    );
    assert.equal(before.rows[0].n,1);

    const deletionKey="discord:message:"+channelId+":"+messageId+":"+revisionB;
    await emit({
      kind:"deleted",channelId,messageId,revisionKey:revisionB,
      observedAt:"2026-11-19T12:01:00.000Z",contentErased:true,
      deletionReason:"user_requested",producerVersion,
    },"message_deleted",deletionKey);
    const deleted=await runDeliveryBatch(source,destinationPool,{
      workerId:"discord-user-erasure-delete",batchSize:1,leaseMs:120000,
    });
    assert.equal(deleted.delivered,1);
    const state=await destinationPool.query(
      "SELECT deletion_reason FROM discord_message_tombstones WHERE evidence_source_id=$1",
      ["discord:message:"+channelId+":"+messageId],
    );
    assert.deepEqual(state.rows,[{deletion_reason:"user_requested"}]);
    const after=await destinationPool.query(
      "SELECT COUNT(*)::int AS n FROM entity_evidence WHERE source_system='discord' AND evidence_source_id=$1 AND event_kind IN ('message_observed','message_edited')",
      ["discord:message:"+channelId+":"+messageId],
    );
    assert.equal(after.rows[0].n,0);
    const deletionTimeline=await destinationPool.query(
      "SELECT COUNT(*)::int AS n FROM timeline_events WHERE source_system='discord' AND source_event_kind='message_deleted' AND event_key=$1",
      [deletionKey],
    );
    assert.equal(deletionTimeline.rows[0].n,1);
  }finally{
    if(destinationPool)await destinationPool.end();
    if(sourcePool)await sourcePool.end();
    try{await admin.query('DROP SCHEMA IF EXISTS "'+destinationSchema+'" CASCADE')}catch{}
    try{await admin.query('DROP SCHEMA IF EXISTS "'+sourceSchema+'" CASCADE')}catch{}
    await admin.end();
  }
});
