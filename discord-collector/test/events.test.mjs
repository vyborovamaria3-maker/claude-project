import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {validateAuthorization,normalizeMessage,allowedObservation,isMetadataOnlyMessageUpdate} from "../src/events.mjs";
const guildId="123456789012345678";
const channelId="223456789012345678";
const messageId="323456789012345678";
const valid={version:2,mode:"collect",guilds:[{guild_id:guildId,channel_ids:[channelId],
 policy_review_reference:"demo-policy",policy_review_expires_at:"2026-12-19T00:00:00Z",
 community_permission_reference:"demo-consent",community_permission_expires_at:"2026-12-19T00:00:00Z",
 reviewed_by:"test",retention_days:30}]};
const mock={id:messageId,guildId,channelId,author:{id:"423456789012345678"},
 content:"Solana token!",createdAt:new Date("2024-05-01T00:00:00Z"),editedAt:null};
test("Gateway snapshots never retain content when the author identity is missing",()=>{
 const source=readFileSync(new URL("../src/index.mjs",import.meta.url),"utf8");
 assert.match(source,/content:authorId!==null&&typeof message\.content==="string"\?message\.content:null/);
});

test("metadata-only MESSAGE_UPDATE events do not become content revisions",()=>{
 assert.equal(isMetadataOnlyMessageUpdate({kind:"edited"},{editedAt:null}),true);
 assert.equal(isMetadataOnlyMessageUpdate({kind:"edited",editedAt:"2026-11-19T12:00:00.000Z"},{editedAt:null}),false);
 assert.equal(isMetadataOnlyMessageUpdate({kind:"edited"},{editedAt:new Date("2026-11-19T12:00:00.000Z")}),false);
 assert.equal(isMetadataOnlyMessageUpdate({kind:"observed"},{editedAt:null}),false);
});

test("default deny missing guild/channel permission",()=>{
 assert.throws(()=>validateAuthorization({guilds:[]}));
 assert.throws(()=>validateAuthorization({guilds:[{guild_id:guildId,channel_ids:[channelId],retention_days:30}]}));
 assert.throws(()=>validateAuthorization({guilds:[{...valid.guilds[0],retention_days:0}]}));
 const allowed=validateAuthorization(valid);
 assert.equal(allowedObservation(allowed,normalizeMessage(mock,"observed")),true);
 assert.equal(allowedObservation(allowed,normalizeMessage({...mock,channelId:"555555555555555555"},"observed")),false);
});
test("authorization leases expire at the earliest consent or policy deadline",()=>{
 const now=new Date("2026-11-19T00:00:00Z");
 const expiredConsent=validateAuthorization({
  ...valid,guilds:[{...valid.guilds[0],community_permission_expires_at:"2026-11-18T23:59:59Z"}]
 },{now});
 assert.equal(expiredConsent.size,0);
 assert.deepEqual(expiredConsent.expiredChannels,[channelId]);
 assert.deepEqual(expiredConsent.expiredGuildIds,[guildId]);
 const expiredReview=validateAuthorization({
  ...valid,guilds:[{...valid.guilds[0],policy_review_expires_at:"2026-11-18T23:59:59Z"}]
 },{now});
 assert.equal(expiredReview.size,0);
 assert.deepEqual(expiredReview.expiredChannels,[channelId]);
 const active=validateAuthorization(valid,{now});
 assert.equal(active.size,1);
 assert.equal(active.get(channelId).expiresAt,"2026-12-19T00:00:00.000Z");
});

test("event admission rejects a lease at expiry without waiting for file reload",()=>{
 const allowed=validateAuthorization(valid);
 const observation=normalizeMessage({id:messageId,guildId,channelId,
  author:{id:"423456789012345678"},content:"hello",createdAt:new Date()}, "observed");
 assert.equal(allowedObservation(allowed,observation),true);
 allowed.get(channelId).expiresAt="2026-11-18T00:00:00.000Z";
 assert.equal(allowedObservation(allowed,observation),false);
});

test("empty allowlist requires explicit erasure-only mode and operator opt-in",()=>{
 const empty={version:2,mode:"erasure_only",guilds:[]};
 assert.throws(()=>validateAuthorization(empty),/DISCORD_ALLOW_ERASURE_ONLY/);
 const allowed=validateAuthorization(empty,{allowErasureOnly:true});
 assert.equal(allowed.size,0);
 assert.equal(allowed.erasureOnly,true);
 assert.throws(()=>validateAuthorization({version:2,mode:"collect",guilds:[]}),/nonempty guild list/);
 assert.throws(()=>validateAuthorization({...valid,mode:"erasure_only"}),/must not contain authorized guilds/);
});

test("authorization rejects numeric Snowflakes and unrecognized personal-data fields",()=>{
 assert.throws(()=>validateAuthorization({
  ...valid,guilds:[{...valid.guilds[0],guild_id:123456789012345678}]
 }),/Guild id/);
 assert.throws(()=>validateAuthorization({...valid,operator_notes:"unexpected"}),/unsupported field/);
 assert.throws(()=>validateAuthorization({
  ...valid,guilds:[{...valid.guilds[0],channel_ids:[223456789012345678]}]
 }),/channel snowflake/);
});

test("authorization expiry timestamps and validity horizons are strict",()=>{
 assert.throws(()=>validateAuthorization({
  ...valid,guilds:[{...valid.guilds[0],community_permission_expires_at:"2026-12-19"}]
 }),/offset-aware ISO timestamp/);
 assert.throws(()=>validateAuthorization({
  ...valid,guilds:[{...valid.guilds[0],community_permission_expires_at:"2026-02-31T00:00:00Z"}]
 }),/invalid calendar date/);
 assert.throws(()=>validateAuthorization({
  ...valid,guilds:[{...valid.guilds[0],policy_review_expires_at:"2026-12-19T00:00:00+15:00"}]
 }),/invalid UTC offset/);
 assert.throws(()=>validateAuthorization({
  ...valid,guilds:[{...valid.guilds[0],policy_review_expires_at:"2028-01-01T00:00:00Z"}]
 },{now:new Date("2026-11-19T00:00:00Z")}),/365 days/);
 assert.throws(()=>validateAuthorization({
  ...valid,guilds:[{...valid.guilds[0],channel_ids:[channelId,channelId]}]
 }),/duplicate channel/);
});

test("message revisions stable and deletion drops raw body",()=>{
 const first=normalizeMessage(mock,"observed","2026-11-18T00:00:00Z");
 const repeat=normalizeMessage(mock,"observed","2026-11-18T00:00:01Z");
 assert.equal(first.revisionKey,repeat.revisionKey);
 assert.equal(first.occurredAt,"2024-05-01T00:00:00.000Z");
 const erased=normalizeMessage(mock,"deleted");
 assert.equal(erased.content,null);
 assert.equal(erased.contentSha,null);
 assert.notEqual(first.revisionKey,erased.revisionKey);
});
test("retained observations and edits require an author ID for later erasure",()=>{
 assert.throws(()=>normalizeMessage({...mock,author:null},"observed"),/author ID for erasure/);
 assert.throws(()=>normalizeMessage({...mock,author:null,editedAt:new Date("2024-05-01T01:00:00Z")},"edited"),/author ID for erasure/);
 assert.doesNotThrow(()=>normalizeMessage({id:messageId,channelId},"deleted",new Date().toISOString(),guildId));
});
test("partial deletion can be resolved only with trusted allowed guild id",()=>{
 const deletion=normalizeMessage({id:messageId,channelId},"deleted",new Date().toISOString(),guildId);
 assert.equal(deletion.guildId,guildId);
 assert.equal(deletion.content,null);
 assert.throws(()=>normalizeMessage({id:messageId,channelId},"deleted"));
});
test("edits with unknown source ordering fail closed",()=>{
 assert.throws(()=>normalizeMessage(mock,"edited"),/editedAt/);
 const edited=normalizeMessage({...mock,editedAt:new Date("2024-05-01T01:00:00Z")},"edited");
 assert.equal(edited.revisionAt,"2024-05-01T01:00:00.000Z");
});
test("Snowflake identifiers above unsigned 64-bit range are rejected",()=>{
 assert.throws(()=>normalizeMessage({...mock,id:"18446744073709551616"},"observed"),/Snowflake/i);
 assert.throws(()=>validateAuthorization({...valid,guilds:[{...valid.guilds[0],guild_id:"18446744073709551616"}]}),/Guild id/);
});

test("invalid IDs, event types and timestamps rejected",()=>{
 assert.throws(()=>normalizeMessage({...mock,id:"123"},"observed"));
 assert.throws(()=>normalizeMessage(mock,"unknown"));
 assert.throws(()=>normalizeMessage(mock,"observed","2024-05-01T10:00:00"));
});
