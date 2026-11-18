import test from "node:test";
import assert from "node:assert/strict";
import {validateAuthorization,normalizeMessage,allowedObservation} from "../src/events.mjs";
const guildId="123456789012345678";
const channelId="223456789012345678";
const messageId="323456789012345678";
const valid={guilds:[{guild_id:guildId,channel_ids:[channelId],
 policy_review_reference:"demo-policy",community_permission_reference:"demo-consent",
 reviewed_by:"test",retention_days:30}]};
const mock={id:messageId,guildId,channelId,author:{id:"423456789012345678"},
 content:"Solana token!",createdAt:new Date("2024-05-01T00:00:00Z"),editedAt:null};
test("default deny missing guild/channel permission",()=>{
 assert.throws(()=>validateAuthorization({guilds:[]}));
 assert.throws(()=>validateAuthorization({guilds:[{guild_id:guildId,channel_ids:[channelId],retention_days:30}]}));
 const allowed=validateAuthorization(valid);
 assert.equal(allowedObservation(allowed,normalizeMessage(mock,"observed")),true);
 assert.equal(allowedObservation(allowed,normalizeMessage({...mock,channelId:"555555555555555555"},"observed")),false);
});
test("message revisions stable and deletion drops raw body",()=>{
 const first=normalizeMessage(mock,"observed","2026-11-18T00:00:00Z");
 const repeat=normalizeMessage(mock,"observed","2026-11-18T00:00:01Z");
 assert.equal(first.revisionKey,repeat.revisionKey);
 assert.equal(first.occurredAt,"2024-05-01T00:00:00.000Z");
 const erased=normalizeMessage(mock,"deleted");
 assert.equal(erased.content,null);
 assert.notEqual(first.revisionKey,erased.revisionKey);
});
test("invalid IDs and event types rejected",()=>{
 assert.throws(()=>normalizeMessage({...mock,id:"123"},"observed"));
 assert.throws(()=>normalizeMessage(mock,"unknown"));
});
