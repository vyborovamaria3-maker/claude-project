import test from "node:test";
import assert from "node:assert/strict";
import {normalizeMessage} from "../src/events.mjs";
import {buildDiscordOutboxEvent} from "../src/outbox.mjs";

const guildId="123456789012345678";
const channelId="223456789012345678";
const messageId="323456789012345678";
const observedAt="2026-11-18T18:00:02.000Z";
const emittedAt="2026-11-18T18:00:03.000Z";
const createdAt=new Date("2026-11-18T18:00:00.000Z");

test("Discord observed event is V2 metadata-only and does not leak message or author fields",()=>{
  const observation=normalizeMessage({
    id:messageId,guildId,channelId,author:{id:"423456789012345678"},
    createdAt,editedAt:null,content:"PRIVATE MESSAGE TEXT",
    attachments:[{url:"https://cdn.discordapp.com/private"}],
  },"observed",observedAt);
  const event=buildDiscordOutboxEvent(observation,emittedAt);
  assert.equal(event.sourceSystem,"discord");
  assert.equal(event.eventKind,"discord_message_observed");
  assert.equal(event.eventKey,"discord:message:"+guildId+":"+channelId+":"+messageId+":observed");
  assert.equal(event.payload.envelopeVersion,2);
  assert.equal(event.payload.clocks.occurredAt,createdAt.toISOString());
  assert.equal(event.payload.clocks.emittedAt,emittedAt);
  assert.equal(event.payload.coverageRef.status,"partial");
  assert.equal(event.payload.coverageRef.scope,"guild:"+guildId+"/channel:"+channelId);
  assert.equal(event.payload.payload.discordMessage.revisionAt,createdAt.toISOString());
  const serialized=JSON.stringify(event);
  for(const secret of ["PRIVATE MESSAGE TEXT","423456789012345678","cdn.discordapp.com","authorId","attachments","contentSha256","rawPointer"])
    assert.equal(serialized.includes(secret),false,"V2 outbox leaked "+secret);
});

test("Discord edit event is keyed and timestamped by canonical source revision",()=>{
  const editedAt=new Date("2026-11-18T18:05:00.000Z");
  const observation=normalizeMessage({
    id:messageId,guildId,channelId,author:{id:"423456789012345678"},
    createdAt,editedAt,content:"EDITED PRIVATE TEXT",
  },"edited","2026-11-18T18:05:01.000Z");
  const event=buildDiscordOutboxEvent(observation,"2026-11-18T18:05:02.000Z");
  assert.equal(event.eventKind,"discord_message_edited");
  assert.equal(event.eventKey,"discord:message:"+guildId+":"+channelId+":"+messageId+":edited:"+editedAt.toISOString());
  assert.equal(event.payload.clocks.occurredAt,editedAt.toISOString());
  assert.equal(event.payload.payload.timelineEvent.occurredAt,editedAt.toISOString());
  assert.equal(JSON.stringify(event).includes("EDITED PRIVATE TEXT"),false);
});

test("Discord delete is a content-free tombstone without a timeline row",()=>{
  const observation=normalizeMessage({id:messageId,channelId},"deleted",observedAt,guildId);
  const event=buildDiscordOutboxEvent(observation,emittedAt);
  assert.equal(event.eventKind,"discord_message_deleted");
  assert.equal(event.eventKey,"discord:message:"+guildId+":"+channelId+":"+messageId+":deleted");
  assert.equal(event.payload.clocks.occurredAt,null);
  assert.equal(Object.hasOwn(event.payload.payload,"timelineEvent"),false);
  assert.deepEqual(event.payload.payload.discordMessage,{guildId,channelId,messageId});
});

test("Discord outbox builder rejects out-of-range Snowflakes and unsupported event kinds",()=>{
  const observation=normalizeMessage({id:messageId,guildId,channelId,createdAt,content:"x"},"observed",observedAt);
  assert.throws(()=>buildDiscordOutboxEvent({...observation,messageId:"18446744073709551616"},emittedAt),/Snowflakes/);
  assert.throws(()=>buildDiscordOutboxEvent({...observation,kind:"unknown"},emittedAt),/Unsupported/);
});
