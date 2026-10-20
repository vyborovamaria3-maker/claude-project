import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTokenLinksInvalidatedEvent,validateTokenLinksInvalidatedEvent,
  buildEntityRef,buildEvidenceRef,formatSourceId,formatAuthorId,
} from "../dist/index.js";

const first="2026-10-20T01:00:00Z";
const second="2026-10-20T01:05:00Z";
const sha="a".repeat(64);
function sample(kind="tg",reason="edited"){
  const sourceEntity=buildEntityRef({
    kind:kind==="tg"?"source":"author",
    canonicalId:kind==="tg"?formatSourceId("tg","1234"):formatAuthorId("x","777"),
    firstSeenAt:second,lastSeenAt:second,
  });
  const evidenceRef=kind==="tg"?buildEvidenceRef({
    sourceKind:"tg_message",sourceAccountId:"1234",messageId:"42",
    observedAt:second,occurredAt:first,
  }):buildEvidenceRef({
    sourceKind:"x_tweet",tweetId:"42",observedAt:second,occurredAt:first,
  });
  return {sourceSystem:kind,sourceEntity,evidenceRef,reason,sourceRevisionSha256:sha};
}

test("X/TG invalidation is an immutable source-level tombstone with no leaked body",()=>{
  for(const kind of ["x","tg"]){
    const e=buildTokenLinksInvalidatedEvent(sample(kind));
    assert.equal(e.eventKind,"token_links_invalidated");
    assert.equal(e.schemaVersion,"token-link-v1");
    assert.equal(e.payload.registryEvent.entityRefs.length,1);
    assert.equal(e.payload.tokenLinksInvalidation.reason,"edited");
    assert.ok(!Object.hasOwn(e.payload,"timelineEvent"));
    assert.deepEqual(validateTokenLinksInvalidatedEvent(e),e);
    assert.deepEqual(buildTokenLinksInvalidatedEvent(sample(kind)),e);
  }
});

test("reject mismatched IDs, malformed revision, forged source and corrupted envelope",()=>{
  const base=sample(),event=buildTokenLinksInvalidatedEvent(base);
  for(const bad of [
    {...base,reason:"unknown"},
    {...base,sourceRevisionSha256:"bad"},
    {...base,sourceSystem:"x"},
    {...base,evidenceRef:{...base.evidenceRef,sourceId:"tg:message:@handle:42"}},
    {...base,sourceEntity:{...base.sourceEntity,kind:"wallet"}},
  ])assert.throws(()=>buildTokenLinksInvalidatedEvent(bad));
  for(const bad of [
    {...event,eventKey:"forged"},
    {...event,payload:{...event.payload,tokenLinksInvalidation:{...event.payload.tokenLinksInvalidation,reason:"unknown"}}},
    {...event,payload:{...event.payload,registryEvent:{...event.payload.registryEvent,entityRefs:[]}}},
  ])assert.throws(()=>validateTokenLinksInvalidatedEvent(bad));
});
