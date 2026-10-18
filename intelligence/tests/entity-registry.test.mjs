import test from "node:test";
import assert from "node:assert/strict";
import {buildEntityRef, buildEvidenceRef, formatTokenId} from "@claude-project/contracts";
import {ingestRegistryEvent,validateRegistryEvent} from "../dist/index.js";

const T="2026-10-18T00:00:00Z";
const entity=buildEntityRef({
  kind:"token",canonicalId:formatTokenId("solana","So11111111111111111111111111111111111111112"),
  firstSeenAt:T,lastSeenAt:T
});
const evidence=buildEvidenceRef({
  sourceKind:"tg_message",sourceAccountId:"-100111",messageId:"17",observedAt:T
});
const event={sourceSystem:"tg",eventKind:"message_observed",eventKey:"tg:-100111:17:v1",
  schemaVersion:"tg-message-v1",entityRefs:[entity],evidenceRef:evidence};

test("rejects noncanonical IDs and invalid provenance",()=>{
  assert.equal(validateRegistryEvent(event).entityRefs[0].canonicalId,entity.canonicalId);
  assert.throws(()=>validateRegistryEvent({...event,entityRefs:[]}),/entityRefs/);
  assert.throws(()=>validateRegistryEvent({...event,entityRefs:[{...entity,canonicalId:"solana:bad"}]}),/Noncanonical/);
  assert.throws(()=>validateRegistryEvent({...event,evidenceRef:{...evidence,sourceId:"x:tweet:12"}}),/Evidence\/source/);
  assert.throws(()=>validateRegistryEvent({...event,sourceSystem:"x"}),/does not belong/);
});

test("inbox is written before entity and source evidence",async()=>{
  const calls=[];
  const tx={query:async(sql,params)=>{
    calls.push({sql,params});
    return {rows:sql.includes("RETURNING event_key")?[{event_key:event.eventKey}]:[]};
  }};
  assert.equal(await ingestRegistryEvent(tx,event),true);
  assert.equal(calls.length,3);
  assert.match(calls[0].sql,/intelligence_inbox/);
  assert.match(calls[1].sql,/LEAST/);
  assert.match(calls[1].sql,/GREATEST/);
  assert.match(calls[2].sql,/entity_evidence/);
  assert.equal(calls[2].params[5],evidence.sourceId);
});

test("repeat delivery is detected without graph duplicates",async()=>{
  const calls=[];
  const tx={query:async(sql,params)=>{calls.push({sql,params});return {rows:[]};}};
  assert.equal(await ingestRegistryEvent(tx,event),false);
  assert.equal(calls.length,1);
});
