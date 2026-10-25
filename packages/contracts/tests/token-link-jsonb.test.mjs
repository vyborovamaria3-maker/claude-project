import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEntityRef,buildEvidenceRef,buildVerifiedTokenLinkEvent,
  buildTokenLinksInvalidatedEvent,validateVerifiedTokenLinkEvent,
  validateTokenLinksInvalidatedEvent,formatAuthorId,formatSourceId,
} from "../dist/index.js";

const mint="So11111111111111111111111111111111111111112";
const observed="2026-10-22T13:00:00Z";
const occurred="2026-10-18T01:00:00Z";
const rev="a".repeat(64);

// PostgreSQL JSONB reorders object keys while preserving arrays and values.
// Re-key nested objects without changing the actual evidence being validated.
function rekey(value){
  if(Array.isArray(value))return value.map(rekey);
  if(value && typeof value==="object"){
    return Object.fromEntries(Object.entries(value).reverse().map(
      ([key,item])=>[key,rekey(item)],
    ));
  }
  return value;
}
function source(system){
  return {
    sourceSystem:system,
    sourceEntity:buildEntityRef({
      kind:system==="tg"?"source":"author",
      canonicalId:system==="tg"?formatSourceId("tg","12345"):
        formatAuthorId("x","9999"),
      firstSeenAt:observed,lastSeenAt:observed,
    }),
    evidenceRef:system==="tg"?buildEvidenceRef({
      sourceKind:"tg_message",sourceAccountId:"12345",messageId:"78",
      observedAt:observed,occurredAt:occurred,
      parserVersion:"tg-mint-verifier-v1",
    }):buildEvidenceRef({
      sourceKind:"x_tweet",tweetId:"900001",
      observedAt:observed,occurredAt:occurred,
      parserVersion:"x-mint-verifier-v1",
    }),
  };
}
test("Postgres JSONB object key normalization cannot invalidate real TG/X verified proofs",()=>{
  for(const system of ["tg","x"]){
    const valid=buildVerifiedTokenLinkEvent({
      ...source(system),mint,matchedLiteralMint:mint,sourceRevisionSha256:rev,
      mintVerification:{
        chainId:"solana-mainnet",method:"spl_mint_account",
        tokenProgram:"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        provider:"alchemy-solana-rpc",checkedAt:observed,
      },
    });
    const persisted=rekey(valid);
    assert.notEqual(JSON.stringify(valid.payload.registryEvent),
      JSON.stringify(persisted.payload.registryEvent));
    assert.deepEqual(validateVerifiedTokenLinkEvent(persisted),persisted);
    // Structural equality remains strict about extra keys and tampered proof.
    for(const bad of [
      {...persisted,payload:{...persisted.payload,tokenLink:{
        ...persisted.payload.tokenLink,sourceRevisionSha256:"b".repeat(64),
      }}},
      {...persisted,payload:{...persisted.payload,tokenLink:{
        ...persisted.payload.tokenLink,unexpectedNewClaim:true,
      }}},
      {...persisted,payload:{...persisted.payload,registryEvent:{
        ...persisted.payload.registryEvent,evidenceRef:{
          ...persisted.payload.registryEvent.evidenceRef,sourceId:"x:tweet:12345678",
        },
      }}},
    ]){
      assert.throws(()=>validateVerifiedTokenLinkEvent(bad));
    }
  }
});
test("source-wide TG/X invalidation tolerates JSONB keys without accepting forged tombstones",()=>{
  for(const system of ["tg","x"]){
    const valid=buildTokenLinksInvalidatedEvent({
      ...source(system),reason:"edited",sourceRevisionSha256:"c".repeat(64),
    });
    const persisted=rekey(valid);
    assert.notEqual(JSON.stringify(valid.payload.registryEvent),
      JSON.stringify(persisted.payload.registryEvent));
    assert.deepEqual(validateTokenLinksInvalidatedEvent(persisted),persisted);
    for(const bad of [
      {...persisted,payload:{...persisted.payload,tokenLinksInvalidation:{
        ...persisted.payload.tokenLinksInvalidation,reason:"deleted",
      }}},
      {...persisted,payload:{...persisted.payload,tokenLinksInvalidation:{
        ...persisted.payload.tokenLinksInvalidation,untrusted:true,
      }}},
      {...persisted,payload:{...persisted.payload,registryEvent:{
        ...persisted.payload.registryEvent,eventKey:"wrong",
      }}},
    ]){
      assert.throws(()=>validateTokenLinksInvalidatedEvent(bad));
    }
  }
});
