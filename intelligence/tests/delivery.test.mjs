import test from "node:test";
import assert from "node:assert/strict";
import {buildEvidenceRef,buildEntityRef,formatTokenId} from "@claude-project/contracts";
import {runDeliveryBatch} from "../dist/index.js";

const when="2026-10-18T00:00:00Z";
const registryEvent={
  sourceSystem:"tg",eventKind:"message_observed",eventKey:"tg:-10022:42:v1",
  schemaVersion:"tg-v1",
  entityRefs:[buildEntityRef({kind:"token",
    canonicalId:formatTokenId("solana","So11111111111111111111111111111111111111112"),
    firstSeenAt:when,lastSeenAt:when})],
  evidenceRef:buildEvidenceRef({
    sourceKind:"tg_message",sourceAccountId:"-10022",messageId:"42",observedAt:when}),
};
function sample(payload={registryEvent}){
  return {id:"1",sourceSystem:"tg",eventKind:"message_observed",eventKey:"tg:-10022:42:v1",
    schemaVersion:"tg-v1",payload,attempts:0,leaseOwner:"worker1",leaseUntil:"2026-10-18T00:30:00Z"};
}
function stubDestination(log, fail=false) {
  return {connect:async()=>({
    query:async sql=>{
      log.push(sql);
      if(fail && sql.includes("entity_registry")) throw new Error("DB unavailable");
      return {rows:sql.includes("RETURNING event_key")?[{event_key:"ok"}]:[]};
    },
    release:()=>log.push("release")
  })};
}
test("ACK only after destination commit",async()=>{
  const log=[];
  const source={claim:async()=>[sample()],ack:async()=>{log.push("ACK");return true},
    fail:async()=>{log.push("FAIL");return true}};
  const stats=await runDeliveryBatch(source,stubDestination(log),
    {workerId:"worker1",batchSize:10,leaseMs:5000});
  assert.equal(stats.delivered,1);
  assert.equal(stats.failed,0);
  assert.ok(log.indexOf("COMMIT")<log.indexOf("ACK"));
  assert.ok(!log.includes("FAIL"));
  assert.ok(log.indexOf("release")<log.indexOf("ACK"));
});

test("rollback before NACK on failed destination write",async()=>{
  const log=[];
  const source={claim:async()=>[sample()],ack:async()=>{log.push("ACK");return true},
    fail:async(e,code)=>{log.push("FAIL:"+code);return true}};
  const stats=await runDeliveryBatch(source,stubDestination(log,true),
    {workerId:"worker1",batchSize:10,leaseMs:5000});
  assert.equal(stats.failed,1);
  assert.equal(stats.delivered,0);
  assert.ok(log.indexOf("ROLLBACK")<log.indexOf("FAIL:delivery_failed"));
  assert.ok(!log.includes("ACK"));
});

test("mismatched envelope fails closed without opening destination",async()=>{
  const log=[];
  const source={claim:async()=>[sample({registryEvent:{...registryEvent,eventKey:"changed"}})],
    ack:async()=>{log.push("ACK");return true},
    fail:async(e,code)=>{log.push(code);return true}};
  const stats=await runDeliveryBatch(source,stubDestination(log),
    {workerId:"worker1",batchSize:10,leaseMs:5000});
  assert.equal(stats.failed,1);
  assert.deepEqual(log,["payload_invalid"]);
});

test("expired ACK lease is not counted as delivery",async()=>{
  const log=[];
  const source={claim:async()=>[sample()],
    ack:async()=>false,fail:async()=>true};
  const stats=await runDeliveryBatch(source,stubDestination(log),
    {workerId:"worker1",batchSize:10,leaseMs:5000});
  assert.equal(stats.delivered,0);
  assert.equal(stats.lostLeases,1);
});

test("cross-source evidence mismatch cannot inject a foreign timeline event",async()=>{
  const log=[];
  const forged={
    schemaVersion:"timeline-v1",eventKey:registryEvent.eventKey,kind:"tg_message_published",
    occurredAt:when,observedAt:when,
    entityRefs:registryEvent.entityRefs,
    evidenceRef:{...registryEvent.evidenceRef,sourceId:"tg:message:-10022:43"},
    payload:{},
  };
  const source={
    claim:async()=>[sample({registryEvent,timelineEvent:forged})],
    ack:async()=>{log.push("ACK");return true},
    fail:async(event,code)=>{log.push("FAIL:"+code);return true},
  };
  const stats=await runDeliveryBatch(source,stubDestination(log),
    {workerId:"worker1",batchSize:10,leaseMs:5000});
  assert.equal(stats.failed,1);
  assert.deepEqual(log,["FAIL:payload_invalid"],"destination must never be opened");
});

test("timeline cannot silently replace canonical entity or rewrite observation time",async()=>{
  const foreign={
    ...registryEvent.entityRefs[0],
    canonicalId:formatTokenId("solana","EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  };
  for (const timelineEvent of [
    {schemaVersion:"timeline-v1",eventKey:registryEvent.eventKey,
      kind:"tg_message_published",occurredAt:when,observedAt:when,
      entityRefs:[foreign],evidenceRef:registryEvent.evidenceRef,payload:{}},
    {schemaVersion:"timeline-v1",eventKey:registryEvent.eventKey,
      kind:"tg_message_published",occurredAt:when,observedAt:"2026-10-18T00:01:00Z",
      entityRefs:registryEvent.entityRefs,evidenceRef:registryEvent.evidenceRef,payload:{}},
  ]) {
    const log=[];
    const source={claim:async()=>[sample({registryEvent,timelineEvent})],
      ack:async()=>{log.push("ACK");return true},
      fail:async(e,code)=>{log.push(code);return true}};
    const result=await runDeliveryBatch(source,stubDestination(log),
      {workerId:"worker1",batchSize:10,leaseMs:5000});
    assert.equal(result.failed,1);
    assert.deepEqual(log,["payload_invalid"]);
  }
});
