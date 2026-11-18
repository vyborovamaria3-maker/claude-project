import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEvidenceRef, formatDiscordChannelId, buildEntityRef,
  adaptLegacyOutboxEventToV2, validateEventEnvelopeV2,
  getSchemaDefinition, validateRegisteredPayload,
} from "../dist/index.js";

const guildId="123456789012345678";
const channelId="223456789012345678";
const messageId="323456789012345678";
const observedAt="2026-11-18T18:00:00.000Z";
const occurredAt="2026-11-18T17:59:00.000Z";
const revisionKey="a".repeat(64);
const contentSha="b".repeat(64);

function event(kind){
  const eventKind={observed:"message_observed",edited:"message_edited",deleted:"message_deleted"}[kind];
  const eventKey="discord:"+guildId+":"+channelId+":"+messageId+":"+revisionKey;
  const evidenceRef=buildEvidenceRef({
    sourceKind:"discord_message",guildId,channelId,messageId,observedAt,
    ...(kind==="deleted"?{}:{occurredAt}),
    provider:"discord-api",parserVersion:"discord-collector/0.1.0"
  });
  const source=buildEntityRef({kind:"source",canonicalId:formatDiscordChannelId(guildId,channelId),
    firstSeenAt:observedAt,lastSeenAt:observedAt});
  const payload={
    registryEvent:{sourceSystem:"discord",eventKind,eventKey,schemaVersion:"discord-message-v1",
      entityRefs:[source],evidenceRef},
    messageRevision:{revisionKey,revisionAt:kind==="deleted"?null:occurredAt,kind,
      contentSha256:kind==="deleted"?null:contentSha}
  };
  return {sourceSystem:"discord",eventKind,eventKey,schemaVersion:"discord-message-v1",payload};
}

test("Discord channel and message IDs are canonical Snowflake identities",()=>{
  assert.equal(formatDiscordChannelId(guildId,channelId),"discord:channel:"+guildId+":"+channelId);
  assert.throws(()=>formatDiscordChannelId("bad",channelId),/Snowflakes/);
  assert.equal(buildEvidenceRef({sourceKind:"discord_message",guildId,channelId,messageId,observedAt}).sourceId,
    "discord:message:"+guildId+":"+channelId+":"+messageId);
  assert.throws(()=>buildEvidenceRef({sourceKind:"discord_message",guildId,channelId,messageId:"12",observedAt}),/Snowflakes/);
});

test("Discord message create/edit/delete schemas are registered and typed",()=>{
  for(const kind of ["message_observed","message_edited","message_deleted"])
    assert.ok(getSchemaDefinition("discord",kind,"discord-message-v1"));
  assert.equal(getSchemaDefinition("discord","message_created","discord-message-v1"),undefined);
});

test("Discord source outbox V1 payload adapts to canonical Event Envelope V2",()=>{
  for(const kind of ["observed","edited","deleted"]){
    const source=event(kind);
    assert.doesNotThrow(()=>validateRegisteredPayload({
      sourceSystem:source.sourceSystem,eventKind:source.eventKind,
      eventKey:source.eventKey,schemaVersion:source.schemaVersion
    },source.payload));
    const envelope=adaptLegacyOutboxEventToV2(source,{emittedAt:"2026-11-18T18:00:01.000Z"});
    assert.equal(envelope.sourceSystem,"discord");
    assert.equal(envelope.evidenceRefs[0].sourceKind,"discord_message");
    assert.equal(envelope.entityRefs[0].canonicalId,"discord:channel:"+guildId+":"+channelId);
    assert.equal(envelope.clocks.emittedAt,"2026-11-18T18:00:01.000Z");
    assert.doesNotThrow(()=>validateEventEnvelopeV2(envelope));
    assert.doesNotMatch(JSON.stringify(envelope),/authorId|first message body|secret invite/);
  }
});

test("Discord contract rejects mismatched channel entity, revision kind and raw message content",()=>{
  const source=event("observed");
  const wrongEntity=structuredClone(source.payload);
  wrongEntity.registryEvent.entityRefs[0].canonicalId="discord:channel:"+guildId+":523456789012345678";
  assert.throws(()=>validateRegisteredPayload({...source},wrongEntity),/channel entity/);
  const wrongKind=structuredClone(source.payload);
  wrongKind.messageRevision.kind="deleted";
  assert.throws(()=>validateRegisteredPayload({...source},wrongKind),/message revision/);
  const raw=structuredClone(source.payload);
  raw.messageRevision.content="secret invite";
  assert.throws(()=>validateRegisteredPayload({...source},raw),/not an allowed field/);
});

test("Discord tombstone cannot carry a retained content hash",()=>{
  const source=event("deleted");
  source.payload.messageRevision.contentSha256=contentSha;
  assert.throws(()=>validateRegisteredPayload({...source},source.payload),/Deleted Discord evidence/);
});
