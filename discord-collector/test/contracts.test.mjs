import test from "node:test";
import assert from "node:assert/strict";
import {buildDiscordMessageEnvelope,validateEventEnvelopeV2} from "@claude-project/contracts";
import {normalizeMessage} from "../src/events.mjs";
const guildId="123456789012345678",channelId="223456789012345678",messageId="323456789012345678";
const mock={id:messageId,guildId,channelId,author:{id:"423456789012345678"},content:"$TOKEN Solana community",createdAt:new Date("2026-11-18T10:00:00Z"),editedAt:null};
test("collector observation converts to V2 without raw message or author data",()=>{
 const o=normalizeMessage(mock,"observed","2026-11-18T10:00:01Z");
 const e=buildDiscordMessageEnvelope({kind:o.kind,channelId:o.channelId,messageId:o.messageId,revisionKey:o.revisionKey,
  occurredAt:o.occurredAt,observedAt:o.observedAt,emittedAt:"2026-11-18T10:00:02Z",contentSha256:o.contentSha,producerVersion:"0.1.0"});
 assert.equal(e.sourceSystem,"discord");assert.equal(e.evidenceRefs[0].contentSha256,o.contentSha);
 assert.equal(JSON.stringify(e).includes(mock.content),false);assert.equal(JSON.stringify(e).includes(mock.author.id),false);
 assert.deepEqual(validateEventEnvelopeV2(JSON.parse(JSON.stringify(e))),e);
});
