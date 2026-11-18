import test from "node:test";
import assert from "node:assert/strict";
import {normalizeMessage,buildDiscordOutboxEvent} from "../src/events.mjs";
import {validateOutboxEvent} from "../../packages/event-outbox/dist/index.js";

const guildId="123456789012345678";
const channelId="223456789012345678";
const messageId="323456789012345678";

test("Discord collector creates a valid privacy-minimized source outbox event",()=>{
  const observation=normalizeMessage({
    id:messageId,guildId,channelId,
    author:{id:"423456789012345678"},
    content:"private raw message body",
    createdAt:new Date("2026-11-18T17:59:00Z"),editedAt:null
  },"observed","2026-11-18T18:00:00Z");
  const event=buildDiscordOutboxEvent(observation);
  assert.doesNotThrow(()=>validateOutboxEvent(event));
  assert.equal(event.sourceSystem,"discord");
  assert.equal(event.eventKind,"message_observed");
  assert.equal(event.payload.registryEvent.evidenceRef.sourceKind,"discord_message");
  assert.equal(event.payload.messageRevision.contentSha256,observation.contentSha);
  const serialized=JSON.stringify(event);
  assert.doesNotMatch(serialized,/private raw message body|423456789012345678/);
  assert.match(serialized,new RegExp(observation.contentSha));
});

test("Discord deleted event carries a tombstone and no content hash",()=>{
  const observation=normalizeMessage({id:messageId,channelId},"deleted",
    "2026-11-18T18:01:00Z",guildId);
  const event=buildDiscordOutboxEvent(observation);
  assert.equal(event.eventKind,"message_deleted");
  assert.equal(event.payload.messageRevision.contentSha256,null);
  assert.equal(event.payload.messageRevision.kind,"deleted");
  assert.doesNotThrow(()=>validateOutboxEvent(event));
});
