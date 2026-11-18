import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {readFile} from "node:fs/promises";
import pg from "pg";
import {
  buildEvidenceRef,buildEntityRef,buildTimelineEvent,buildEventEnvelopeV2,formatSourceId,
} from "@claude-project/contracts";
import {runDeliveryBatch} from "../dist/index.js";

const DB_URL=process.env.INTELLIGENCE_TEST_DB_URL;
const guildId="123456789012345678";
const channelId="223456789012345678";
const messageId="323456789012345678";
const sourceId="discord:message:"+guildId+":"+channelId+":"+messageId;

function discordEvent(kind,occurredAt,observedAt,emittedAt){
  const eventKind={
    observed:"discord_message_observed",
    edited:"discord_message_edited",
    deleted:"discord_message_deleted",
  }[kind];
  const eventKey=kind==="edited"
    ?sourceId+":edited:"+occurredAt
    :sourceId+":"+(kind==="deleted"?"deleted":"observed");
  const evidenceRef=buildEvidenceRef({
    sourceKind:"discord_message",guildId,channelId,messageId,
    observedAt,...(occurredAt?{occurredAt}:{}),
    provider:"discord",parserVersion:"discord-collector-v1",
  });
  const channelRef=buildEntityRef({
    kind:"source",canonicalId:formatSourceId("discord",channelId),
    firstSeenAt:observedAt,lastSeenAt:observedAt,
  });
  const registryEvent={
    sourceSystem:"discord",eventKind,eventKey,schemaVersion:"discord-message-v1",
    entityRefs:[channelRef],evidenceRef,
  };
  const timelineEvent=kind==="deleted"?undefined:buildTimelineEvent({
    eventKey,kind:eventKind,occurredAt,observedAt,
    entityRefs:[channelRef],evidenceRef,payload:{},
  });
  const payload={
    registryEvent,
    ...(timelineEvent?{timelineEvent}:{}),
    discordMessage:kind==="deleted"
      ?{guildId,channelId,messageId}
      :{guildId,channelId,messageId,revisionAt:occurredAt},
  };
  const envelope=buildEventEnvelopeV2({
    sourceSystem:"discord",eventKind,eventKey,schemaVersion:"discord-message-v1",
    producer:{name:"discord-collector",version:"integration-test"},
    clocks:{occurredAt:occurredAt??null,observedAt,emittedAt},
    entityRefs:[{kind:"source",canonicalId:channelRef.canonicalId}],
    evidenceRefs:[evidenceRef],
    coverageRef:{
      sourceSystem:"discord",scope:"guild:"+guildId+"/channel:"+channelId,
      windowStart:occurredAt??observedAt,windowEnd:observedAt,
      status:"partial",coverageId:"discord-integration:"+channelId,
    },
    payload,
  });
  return {
    id:randomBytes(8).toString("hex"),sourceSystem:"discord",eventKind,eventKey,
    schemaVersion:"discord-message-v1",payload:envelope,createdAt:emittedAt,
    attempts:0,leaseOwner:"discord-test",leaseUntil:"2999-01-01T00:00:00.000Z",
  };
}

test("Discord V2 delivery stores metadata and a delete tombstone retracts earlier timeline/evidence atomically",{
  skip:!DB_URL,
},async()=>{
  const schema="discord_delivery_"+randomBytes(5).toString("hex");
  const admin=new pg.Client({connectionString:DB_URL});
  let pool;
  await admin.connect();
  try{
    await admin.query('CREATE SCHEMA "'+schema+'"');
    await admin.query('SET search_path TO "'+schema+'"');
    for(const name of [
      "001_entity_registry.sql","002_timeline.sql","004_token_link_observations.sql",
      "017_inbox_payload_fingerprint.sql","019_inbox_envelope_fingerprint.sql",
      "022_discord_message_contracts.sql",
    ]){
      await admin.query(await readFile(new URL("../migrations/"+name,import.meta.url),"utf8"));
    }
    pool=new pg.Pool({connectionString:URL,options:"-c search_path="+schema,max:2});
    const deliver=async event=>{
      let claimed=false;
      const failureCodes=[];
      const source={
        claim:async()=>claimed?[]:(claimed=true,[event]),
        ack:async()=>true,
        fail:async(_event,code)=>{failureCodes.push(code);return true;},
      };
      return {...await runDeliveryBatch(source,pool,{workerId:"discord-test",batchSize:1,leaseMs:5000}),failureCodes};
    };
    const createdAt="2026-11-18T18:00:00.000Z";
    const observedAt="2026-11-18T18:00:02.000Z";
    const emittedAt="2026-11-18T18:00:03.000Z";
    const observedResult=await deliver(discordEvent("observed",createdAt,observedAt,emittedAt));
    assert.equal(observedResult.delivered,1,JSON.stringify(observedResult));
    const editedAt="2026-11-18T18:05:00.000Z";
    const editedObservedAt="2026-11-18T18:05:01.000Z";
    const editedEmittedAt="2026-11-18T18:05:02.000Z";
    const editedResult=await deliver(discordEvent("edited",editedAt,editedObservedAt,editedEmittedAt));
    assert.equal(editedResult.delivered,1,JSON.stringify(editedResult));
    let rows=await pool.query(
      "SELECT COUNT(*)::int AS n FROM timeline_events WHERE source_system='discord' AND evidence_source_id=$1",
      [sourceId]);
    assert.equal(rows.rows[0].n,2);
    rows=await pool.query(
      "SELECT COUNT(*)::int AS n FROM entity_evidence WHERE source_system='discord' AND evidence_source_id=$1",
      [sourceId]);
    assert.equal(rows.rows[0].n,2);

    const deletedObservedAt="2026-11-18T18:06:00.000Z";
    const deletedEmittedAt="2026-11-18T18:06:01.000Z";
    const tombstone=discordEvent("deleted",undefined,deletedObservedAt,deletedEmittedAt);
    const deletedResult=await deliver(tombstone);
    assert.equal(deletedResult.delivered,1,JSON.stringify(deletedResult));
    rows=await pool.query(
      "SELECT COUNT(*)::int AS n FROM timeline_events WHERE source_system='discord' AND evidence_source_id=$1",
      [sourceId]);
    assert.equal(rows.rows[0].n,0);
    rows=await pool.query(
      "SELECT COUNT(*)::int AS n FROM timeline_event_entities WHERE source_system='discord' AND event_key IN "+
      "(SELECT event_key FROM intelligence_inbox WHERE source_system='discord' AND evidence_source_id=$1)",
      [sourceId]);
    assert.equal(rows.rows[0].n,0);
    rows=await pool.query(
      "SELECT event_kind FROM entity_evidence WHERE source_system='discord' AND evidence_source_id=$1",
      [sourceId]);
    assert.deepEqual(rows.rows.map(row=>row.event_kind),["discord_message_deleted"]);
    rows=await pool.query(
      "SELECT COUNT(*)::int AS n FROM intelligence_inbox WHERE source_system='discord' AND evidence_source_id=$1",
      [sourceId]);
    assert.equal(rows.rows[0].n,3);

    // Duplicate tombstones replay idempotently and keep the retraction in force.
    const duplicate=await deliver(tombstone);
    assert.equal(duplicate.duplicates,1);
    rows=await pool.query(
      "SELECT COUNT(*)::int AS n FROM timeline_events WHERE source_system='discord' AND evidence_source_id=$1",
      [sourceId]);
    assert.equal(rows.rows[0].n,0);
  }finally{
    if(pool)await pool.end();
    await admin.query("SET search_path TO public");
    await admin.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
    await admin.end();
  }
});
