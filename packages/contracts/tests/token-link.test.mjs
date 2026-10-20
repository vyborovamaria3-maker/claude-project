import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEntityRef, buildEvidenceRef, buildVerifiedTokenLinkEvent,
  formatAuthorId, formatSourceId, SOLANA_TOKEN_PROGRAMS,
} from "../dist/index.js";

const mint="So11111111111111111111111111111111111111112";
const another="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const observed="2026-10-20T01:00:00.000Z";
const checked="2026-10-20T00:59:59.000Z";
const revision="a".repeat(64);

function social(sourceSystem="tg"){
  const isTG=sourceSystem==="tg";
  return {
    sourceSystem,
    sourceEntity:buildEntityRef({
      kind:isTG?"source":"author",
      canonicalId:isTG?formatSourceId("tg","1234"):formatAuthorId("x","5001"),
      firstSeenAt:observed,lastSeenAt:observed,
    }),
    evidenceRef:isTG?buildEvidenceRef({
      sourceKind:"tg_message",sourceAccountId:"1234",messageId:"20",
      observedAt:observed,occurredAt:"2026-10-19T22:00:00Z",
    }):buildEvidenceRef({
      sourceKind:"x_tweet",tweetId:"100",
      observedAt:observed,occurredAt:"2026-10-19T22:00:00Z",
    }),
    mint,matchedLiteralMint:mint,sourceRevisionSha256:revision,
    mintVerification:{
      chainId:"solana-mainnet",method:"spl_mint_account",
      tokenProgram:SOLANA_TOKEN_PROGRAMS[0],provider:"alchemy-solana-rpc",
      checkedAt:checked,
    },
  };
}

test("confirmed native mint evidence creates source-qualified immutable link observation",()=>{
  for(const source of ["x","tg"]){
    const e=buildVerifiedTokenLinkEvent(social(source));
    assert.equal(e.schemaVersion,"token-link-v1");
    assert.equal(e.eventKind,"token_link_verified");
    assert.equal(e.payload.tokenLink.canonicalTokenId,"solana:"+mint);
    assert.equal(e.payload.registryEvent.entityRefs.at(-1)?.canonicalId,"solana:"+mint);
    assert.equal(e.payload.registryEvent.evidenceRef.sourceKind,source==="tg"?"tg_message":"x_tweet");
    assert.equal(e.payload.registryEvent.evidenceRef.observedAt,observed);
    assert.equal(Object.hasOwn(e.payload,"timelineEvent"),false,
      "live/current timeline requires separate retraction-aware materialization");
    assert.deepEqual(buildVerifiedTokenLinkEvent(social(source)),e);
    assert.ok(!JSON.stringify(e).includes("session"));
  }
});

test("reject ticker/near-match/mint account substitutions, missing RPC proof or wrong chain",()=>{
  const ok=social();
  for(const change of [
    {matchedLiteralMint:"$SOL"},
    {matchedLiteralMint:another},
    {mint:another},
    {sourceRevisionSha256:"changed"},
    {mintVerification:{...ok.mintVerification,tokenProgram:"TokenAccountNotMint"}},
    {mintVerification:{...ok.mintVerification,chainId:"solana-devnet"}},
    {mintVerification:{...ok.mintVerification,checkedAt:"2026-10-20T01:00:01Z"}},
    {mintVerification:{...ok.mintVerification,provider:" "}},
    {sourceEntity:buildEntityRef({kind:"author",canonicalId:"x:123",firstSeenAt:observed,lastSeenAt:observed})},
    {evidenceRef:buildEvidenceRef({sourceKind:"x_tweet",tweetId:"100",observedAt:observed})},
  ]){
    assert.throws(()=>buildVerifiedTokenLinkEvent({...ok,...change}));
  }
  assert.throws(()=>buildVerifiedTokenLinkEvent({
    ...ok,mint:"NotAnAddress",matchedLiteralMint:"NotAnAddress",
  }),/Solana/);
});

test("same evidence+revision keeps identity; new revision or verification yields distinct event",()=>{
  const a=social();
  const first=buildVerifiedTokenLinkEvent(a);
  const revised=buildVerifiedTokenLinkEvent({...a,sourceRevisionSha256:"b".repeat(64)});
  const reverified=buildVerifiedTokenLinkEvent({
    ...a,mintVerification:{...a.mintVerification,checkedAt:"2026-10-20T00:59:58Z"},
  });
  assert.notEqual(first.eventKey,revised.eventKey);
  assert.notEqual(first.eventKey,reverified.eventKey);
});
