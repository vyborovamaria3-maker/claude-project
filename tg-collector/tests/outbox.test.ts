import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTgOutboxEvent,buildTgDeletionOutboxEvent,telegramOutboxEnabled,
} from "../src/persistence/outbox.js";

const now = new Date("2026-10-18T01:30:00Z");
const msg = {
  id: 42,
  date: 1792283400,
  message: "Private channel conversation, should never be exported in outbox.",
  views: 10,
  forwards: 2,
  replies: {replies:1},
};
test("outbox stays off by default; only exact true enables writes",()=>{
  assert.equal(telegramOutboxEnabled({}),false);
  assert.equal(telegramOutboxEnabled({TG_INTELLIGENCE_OUTBOX_ENABLED:"1"}),false);
  assert.equal(telegramOutboxEnabled({TG_INTELLIGENCE_OUTBOX_ENABLED:"true"}),true);
});
test("message evidence uses stable peer, no DB-local surrogate or private text",()=>{
  const e=buildTgOutboxEvent("123456789",msg,now);
  const payload=e.payload as {registryEvent:{
    evidenceRef:{sourceId:string;observedAt:string};entityRefs:{canonicalId:string}[]};
    timelineEvent:{observedAt:string;kind:string}};
  assert.equal(e.sourceSystem,"tg");
  assert.equal(e.schemaVersion,"tg-message-v1");
  assert.equal(payload.registryEvent.evidenceRef.sourceId,"tg:message:123456789:42");
  assert.equal(payload.registryEvent.entityRefs[0]?.canonicalId,"tg:source:123456789");
  assert.equal(payload.timelineEvent.kind,"tg_message_published");
  assert.equal(payload.timelineEvent.observedAt,now.toISOString());
  assert.ok(!JSON.stringify(e).includes(msg.message));
  assert.equal(buildTgOutboxEvent("123456789",msg,new Date("2026-10-18T03:00:00Z")).eventKey,e.eventKey);
  assert.notEqual(buildTgOutboxEvent("123456789",{...msg,views:11},now).eventKey,e.eventKey);
  assert.notEqual(buildTgOutboxEvent("123456789",{...msg,message:"Edited"},now).eventKey,e.eventKey);
});
test("refuse unresolved/mutable channel identity and malformed messages",()=>{
  for(const peer of [null,"@channel","somechannel","0"," 123","-0","+100123"]){
    assert.throws(()=>buildTgOutboxEvent(peer,msg,now),/PEER_UNRESOLVED/);
  }
  assert.throws(()=>buildTgOutboxEvent("123",{...msg,id:0},now),/Invalid Telegram message/);
  assert.throws(()=>buildTgOutboxEvent("123",{...msg,id:1,message:undefined},now),/Invalid Telegram message/);
});
test("delete envelope preserves origin without fabricating timeline publication",()=>{
  const e=buildTgDeletionOutboxEvent("123456789",42,now);
  const payload=e.payload as {registryEvent:{eventKind:string;evidenceRef:{sourceId:string}}};
  assert.equal(e.eventKind,"message_deleted");
  assert.equal(payload.registryEvent.evidenceRef.sourceId,"tg:message:123456789:42");
  assert.ok(!Object.hasOwn(e.payload,"timelineEvent"));
  assert.notEqual(buildTgDeletionOutboxEvent("123456789",42,new Date("2026-10-18T01:30:01Z")).eventKey,e.eventKey);
  assert.equal(buildTgDeletionOutboxEvent("123456789",42,now,"20261018013000123456").eventKey,
    buildTgDeletionOutboxEvent("123456789",42,new Date("2026-10-18T01:30:59Z"),"20261018013000123456").eventKey);
  assert.throws(()=>buildTgDeletionOutboxEvent(null,42,now),/PEER_UNRESOLVED/);
});

test("canonical negative Telegram channel peer ID survives publication and soft-delete",()=>{
  const peer="-100123456789";
  const event=buildTgOutboxEvent(peer,msg,now);
  const registry=event.payload.registryEvent as {
    evidenceRef:{sourceId:string};entityRefs:{canonicalId:string}[];
  };
  assert.equal(registry.evidenceRef.sourceId,"tg:message:-100123456789:42");
  assert.equal(registry.entityRefs[0]?.canonicalId,"tg:source:-100123456789");
  const deleted=buildTgDeletionOutboxEvent(peer,42,now);
  assert.equal((deleted.payload.registryEvent as {
    evidenceRef:{sourceId:string}
  }).evidenceRef.sourceId,"tg:message:-100123456789:42");
});
