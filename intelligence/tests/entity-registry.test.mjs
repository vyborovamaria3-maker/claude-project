import test from "node:test";
import assert from "node:assert/strict";
import {buildEntityRef, buildEvidenceRef, formatTokenId} from "@claude-project/contracts";
import {ingestRegistryEvent,validateRegistryEvent,registryEventFingerprint} from "../dist/index.js";

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
  assert.throws(()=>validateRegistryEvent({...event,evidenceRef:{...evidence,provider:" "}}),/Invalid provider/);
  assert.throws(()=>validateRegistryEvent({...event,evidenceRef:{...evidence,parserVersion:"v".repeat(4097)}}),/Invalid parserVersion/);
  assert.throws(()=>validateRegistryEvent({...event,evidenceRef:{...evidence,rawPointer:" "}}),/Invalid rawPointer/);
  assert.throws(()=>validateRegistryEvent({...event,sourceSystem:"x"}),/does not belong/);
  assert.throws(()=>validateRegistryEvent({...event,evidenceRef:{...evidence,sourceId:"tg:message:-0:17"}}),/Evidence\/source/);
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
  assert.match(calls[0].params[5],/^[0-9a-f]{64}$/);
});

test("repeat delivery checks the complete stable payload fingerprint",async()=>{
  const calls=[];
  const stored={schema_version:event.schemaVersion,evidence_source_id:evidence.sourceId,
    payload_sha256:registryEventFingerprint(event)};
  const tx={query:async(sql,params)=>{
    calls.push({sql,params});
    return {rows:sql.includes("SELECT schema_version")?[stored]:[]};
  }};
  assert.equal(await ingestRegistryEvent(tx,event),false);
  assert.equal(calls.length,2);
  const changedEntity=buildEntityRef({kind:"token",
    canonicalId:formatTokenId("solana","EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    firstSeenAt:T,lastSeenAt:T});
  await assert.rejects(ingestRegistryEvent(tx,{...event,entityRefs:[changedEntity]}),/identity collision/);
  await assert.rejects(ingestRegistryEvent(tx,{
    ...event,evidenceRef:{...evidence,sourceId:"tg:message:-100111:18"}
  }),/identity collision/);
});

test("legacy inbox rows without a fingerprint fail closed",async()=>{
  const tx={query:async sql=>({rows:sql.includes("SELECT schema_version")?[{
    schema_version:event.schemaVersion,evidence_source_id:evidence.sourceId,payload_sha256:null,
  }]:[]})};
  await assert.rejects(ingestRegistryEvent(tx,event),/legacy fingerprint missing/);
});

test("fingerprint is deterministic across entity order and sensitive to evidence revisions",()=>{
  const second=buildEntityRef({kind:"wallet",canonicalId:"solana:"+"1".repeat(32),firstSeenAt:T,lastSeenAt:T});
  const multi={...event,entityRefs:[entity,second]};
  assert.equal(registryEventFingerprint(multi),registryEventFingerprint({...multi,entityRefs:[second,entity]}));
  assert.notEqual(registryEventFingerprint(event),registryEventFingerprint({
    ...event,evidenceRef:{...evidence,observedAt:"2026-10-18T00:01:00Z"},
  }));
});

test("on-chain evidence accepts only valid Solana signatures",()=>{
  assert.throws(()=>validateRegistryEvent({
    ...event,sourceSystem:"blockchain",evidenceRef:{
      ...evidence,sourceKind:"chain_tx",sourceId:"chain:tx:solana:abc"
    }
  }),/Invalid chain transaction evidence/);
  assert.throws(()=>validateRegistryEvent({
    ...event,sourceSystem:"blockchain",evidenceRef:{
      ...evidence,sourceKind:"chain_tx",sourceId:"chain:tx:ethereum:0x"+"a".repeat(64)
    }
  }),/Evidence\/source identity mismatch/);
});
