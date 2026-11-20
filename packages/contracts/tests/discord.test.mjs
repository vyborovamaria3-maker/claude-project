import test from "node:test";
import assert from "node:assert/strict";
import {buildDiscordMessageEnvelope,buildEventEnvelopeV2,validateEventEnvelopeV2,buildEvidenceRef,formatSourceId} from "../dist/index.js";
const observedAt="2026-11-18T10:00:00.000Z",emittedAt="2026-11-18T10:00:01.000Z";
const channelId="223456789012345678",messageId="323456789012345678",hash="a".repeat(64),revision="b".repeat(64);
test("Discord observed event builds valid privacy-minimized V2 envelope",()=>{
 const e=buildDiscordMessageEnvelope({kind:"observed",channelId,messageId,revisionKey:revision,occurredAt:observedAt,observedAt,emittedAt,contentSha256:hash,producerVersion:"0.1.0"});
 assert.equal(e.sourceSystem,"discord");assert.equal(e.eventKind,"message_observed");assert.equal(e.schemaVersion,"discord-message-v1");
 assert.equal(e.entityRefs[0].canonicalId,formatSourceId("discord",channelId));assert.equal(e.evidenceRefs[0].sourceKind,"discord_message");
 assert.equal(e.evidenceRefs[0].contentSha256,hash);assert.equal(e.payload.timelineEvent.payload.contentSha256,hash);
 assert.deepEqual(validateEventEnvelopeV2(JSON.parse(JSON.stringify(e))),e);
});
test("Discord edit event uses source edit timestamp",()=>{
 const editedAt="2026-11-18T10:05:00.000Z";
 const e=buildDiscordMessageEnvelope({kind:"edited",channelId,messageId,revisionKey:revision,occurredAt:editedAt,observedAt:"2026-11-18T10:05:01.000Z",emittedAt:"2026-11-18T10:05:02.000Z",contentSha256:hash,producerVersion:"0.1.0"});
 assert.equal(e.clocks.occurredAt,editedAt);assert.equal(e.payload.timelineEvent.kind,"discord_message_edited");
});
test("Discord deletion contains no body hash or timeline text",()=>{
 const e=buildDiscordMessageEnvelope({kind:"deleted",channelId,messageId,revisionKey:revision,observedAt,emittedAt,contentErased:true,producerVersion:"0.1.0"});
 assert.equal(e.clocks.occurredAt,null);assert.deepEqual(e.payload.messageDeletion,{contentErased:true,reason:"deleted"});
 assert.equal(e.evidenceRefs[0].contentSha256,undefined);assert.equal(e.payload.timelineEvent.kind,"discord_message_deleted");
 assert.deepEqual(e.payload.timelineEvent.payload,{contentErased:true,reason:"deleted"});
 assert.throws(()=>buildDiscordMessageEnvelope({kind:"deleted",channelId,messageId,revisionKey:revision,observedAt,emittedAt,producerVersion:"0.1.0"}),/confirmed content erasure/);
});
test("Discord V2 builder rejects raw text, author IDs and malformed identity",()=>{
 const b={kind:"observed",channelId,messageId,revisionKey:revision,occurredAt:observedAt,observedAt,emittedAt,contentSha256:hash,producerVersion:"0.1.0"};
 assert.throws(()=>buildDiscordMessageEnvelope({...b,content:"raw"}),/Unknown Discord/);
 assert.throws(()=>buildDiscordMessageEnvelope({...b,authorId:"423456789012345678"}),/Unknown Discord/);
 assert.throws(()=>buildDiscordMessageEnvelope({...b,messageId:"123"}),/Snowflake/);
 assert.throws(()=>buildDiscordMessageEnvelope({...b,revisionKey:"bad"}),/revision SHA/);
});
test("Discord evidence IDs reject malformed Snowflakes",()=>{
 assert.throws(()=>buildEvidenceRef({sourceKind:"discord_message",channelId,messageId:"bad",observedAt}),/Snowflake/i);
});
test("Discord deletion reason is explicit and restricted",()=>{
 for(const reason of ["deleted","retention_expired","channel_revoked","user_requested"]){
  const event=buildDiscordMessageEnvelope({kind:"deleted",channelId,messageId,revisionKey:revision,
   observedAt,emittedAt,contentErased:true,deletionReason:reason,producerVersion:"0.1.0"});
  assert.deepEqual(event.payload.messageDeletion,{contentErased:true,reason});
  assert.deepEqual(event.payload.timelineEvent.payload,{contentErased:true,reason});
 }
 assert.throws(()=>buildDiscordMessageEnvelope({kind:"deleted",channelId,messageId,revisionKey:revision,
  observedAt,emittedAt,contentErased:true,deletionReason:"unknown",producerVersion:"0.1.0"}),/deletion reason/);
});



test("Discord content hash must agree across evidence and timeline",()=>{
 const event=buildDiscordMessageEnvelope({kind:"observed",channelId,messageId,revisionKey:revision,occurredAt:observedAt,observedAt,emittedAt,contentSha256:hash,producerVersion:"0.1.0"});
 const payload={...event.payload,timelineEvent:{...event.payload.timelineEvent,payload:{...event.payload.timelineEvent.payload,contentSha256:"c".repeat(64)}}};
 assert.throws(()=>buildEventEnvelopeV2({sourceSystem:event.sourceSystem,eventKind:event.eventKind,eventKey:event.eventKey,
  schemaVersion:event.schemaVersion,producer:event.producer,clocks:event.clocks,entityRefs:event.entityRefs,
  evidenceRefs:event.evidenceRefs,payload}),/Evidence content hash differs/);
});
