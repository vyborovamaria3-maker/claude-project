"use strict";
/**
 * ARCH-06b: immutable, revision-ordered wallet transaction evidence state.
 * This is a source observation, NOT a verified SPL Mint, finalized swap
 * or trade/PnL assertion. An unsupported new raw revision supersedes a
 * previously supported one without deleting any historical event.
 */
const {decodedBytes}=require("./blockchain-intelligence-outbox.cjs");
const {buildTokenSwapEvidenceEvent,enabled}=require("./blockchain-token-swap-outbox.cjs");
const HASH=/^[0-9a-f]{64}$/;
const PARSER_VERSION="1";

function buildTokenSwapRevisionEvent(input){
  if(input.kind!=="wallet")return null;
  if(decodedBytes(input.address)!==32 || decodedBytes(input.signature)!==64)
    throw new TypeError("Invalid canonical Solana wallet or signature");
  if(!HASH.test(input.payloadHash||""))
    throw new TypeError("Invalid raw source SHA256");
  if(!Number.isSafeInteger(input.rawRevision)||input.rawRevision<1)
    throw new TypeError("Invalid monotonic rawRevision");
  if(!Number.isSafeInteger(input.observedAt)||input.observedAt<0)
    throw new TypeError("Invalid observedAt");
  const confirmed=buildTokenSwapEvidenceEvent(input);
  const observedAt=new Date(input.observedAt).toISOString();
  const eventKey="chain:wallet:"+input.address+
    ":signature:"+input.signature+":raw-revision:"+input.rawRevision+
    ":sha256:"+input.payloadHash+":parser:"+PARSER_VERSION;
  const evidenceRef={
    sourceKind:"chain_tx",sourceId:"chain:tx:solana:"+input.signature,
    observedAt,parserVersion:"chain-swap-revision-"+PARSER_VERSION,
    ...(confirmed?{occurredAt:confirmed.payload.registryEvent.evidenceRef.occurredAt}:{}),
  };
  return {
    sourceSystem:"blockchain",eventKind:"token_swap_evidence_revision",
    eventKey,schemaVersion:"chain-token-revision-v1",
    payload:{
      registryEvent:{
        sourceSystem:"blockchain",eventKind:"token_swap_evidence_revision",
        eventKey,schemaVersion:"chain-token-revision-v1",
        // Never link a token to an unsupported raw revision in the registry.
        entityRefs:[{kind:"wallet",canonicalId:"solana:"+input.address,
          firstSeenAt:observedAt,lastSeenAt:observedAt}],
        evidenceRef,
      },
      swapRevision:{
        walletId:"solana:"+input.address,
        signature:input.signature,
        rawRevision:input.rawRevision,
        rawSha256:input.payloadHash,
        status:confirmed?"supported":"unsupported",
        canonicalTokenId:confirmed?
          confirmed.payload.registryEvent.entityRefs[1].canonicalId:null,
        slot:confirmed?input.transaction.slot:null,
      },
    },
  };
}
function emitTokenSwapRevisionOutbox(db,input){
  if(!enabled())return false;
  const event=buildTokenSwapRevisionEvent(input);
  if(!event)return false;
  const now=new Date(input.observedAt).toISOString();
  const result=db.prepare("INSERT OR IGNORE INTO outbox_events "+
    "(source_system,event_kind,event_key,schema_version,payload,created_at,next_attempt_at) "+
    "VALUES(?,?,?,?,?,?,?)").run(event.sourceSystem,event.eventKind,event.eventKey,
      event.schemaVersion,JSON.stringify(event.payload),now,now);
  return result.changes===1;
}
module.exports={buildTokenSwapRevisionEvent,emitTokenSwapRevisionOutbox};
