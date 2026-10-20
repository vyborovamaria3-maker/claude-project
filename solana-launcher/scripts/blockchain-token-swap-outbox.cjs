"use strict";
/**
 * ARCH-06a: a provider-parsed swap is NOT a complete trade tape, finalized
 * account-owner proof or realized PnL. Publish immutable historical provenance
 * only when a single SOL/WSOL-quoted wallet swap leg reconciles to balances.
 */
const {parseEvidence}=require("./blockchain-forensics-core.cjs");
const {decodedBytes,ensureSchema}=require("./blockchain-intelligence-outbox.cjs");
const HASH=/^[0-9a-f]{64}$/;
const DECODER_VERSION="5";
const MAX_EVIDENCE_AGE_MS=20*365*24*60*60*1000;

function enabled(env=process.env){
  return env.BLOCKCHAIN_INTELLIGENCE_OUTBOX_ENABLED==="true" &&
    env.BLOCKCHAIN_INTELLIGENCE_TOKEN_EVENTS_ENABLED==="true";
}
function buildTokenSwapEvidenceEvent(input){
  if(input.kind!=="wallet")return null;
  if(decodedBytes(input.address)!==32 || decodedBytes(input.signature)!==64)
    throw new TypeError("Invalid canonical Solana wallet or transaction signature");
  if(!HASH.test(input.payloadHash||""))
    throw new TypeError("Invalid immutable source payload SHA256");
  if(!Number.isSafeInteger(input.observedAt)||input.observedAt<0)
    throw new TypeError("Invalid observation time");
  const tx=input.transaction;
  if(!tx||typeof tx!=="object"||Array.isArray(tx)||
    tx.signature!==input.signature||tx.type!=="SWAP"||
    tx.error!=null||tx.transactionError!=null||
    !tx.events||!tx.events.swap||!Array.isArray(tx.accountData))return null;
  if(!Number.isSafeInteger(tx.timestamp)||tx.timestamp<=0||
     !Number.isSafeInteger(tx.slot)||tx.slot<=0||
     tx.timestamp*1000>input.observedAt ||
     input.observedAt-tx.timestamp*1000>MAX_EVIDENCE_AGE_MS)return null;
  let parsed;
  try{parsed=parseEvidence(tx,input.address)}
  catch{return null}
  if(!Array.isArray(parsed)||parsed.length!==1)return null;
  const leg=parsed[0];
  if(!leg||!["buy","sell"].includes(leg.kind)||
     leg.wallet!==input.address||leg.signature!==input.signature||
     leg.index!==0||leg.slot!==tx.slot||leg.timestamp!==tx.timestamp||
     decodedBytes(leg.mint)!==32 ||
     !["native","wsol"].includes(leg.quoteKind)||
     !Number.isFinite(leg.amountSol)||!(leg.amountSol>0)||
     !Number.isFinite(leg.amountTokens)||!(leg.amountTokens>0))return null;
  const observedAt=new Date(input.observedAt).toISOString();
  const occurredAt=new Date(tx.timestamp*1000).toISOString();
  const evidenceRef={
    sourceKind:"chain_tx",sourceId:"chain:tx:solana:"+input.signature,
    occurredAt,observedAt,parserVersion:"chain-swap-evidence-"+DECODER_VERSION,
  };
  const entityRefs=[
    {kind:"wallet",canonicalId:"solana:"+input.address,firstSeenAt:observedAt,lastSeenAt:observedAt},
    {kind:"token",canonicalId:"solana:"+leg.mint,firstSeenAt:observedAt,lastSeenAt:observedAt},
  ];
  const eventKey="chain:wallet:"+input.address+
    ":signature:"+input.signature+":sha256:"+input.payloadHash+
    ":mint:"+leg.mint+":leg:0:parser:"+DECODER_VERSION;
  return {
    sourceSystem:"blockchain",eventKind:"token_swap_evidence_observed",
    eventKey,schemaVersion:"chain-token-evidence-v1",
    payload:{
      registryEvent:{
        sourceSystem:"blockchain",eventKind:"token_swap_evidence_observed",
        eventKey,schemaVersion:"chain-token-evidence-v1",
        entityRefs,evidenceRef,
      },
      timelineEvent:{
        schemaVersion:"timeline-v1",eventKey,kind:"chain_transaction",
        occurredAt,observedAt,entityRefs,evidenceRef,
        payload:{
          attribution:"provider_parsed_wallet_swap",
          evidenceStatus:"historical_raw_revision_only",
          decoderVersion:DECODER_VERSION,
          // No raw text, provider output, prices, trade PnL or promises
          // of on-chain finality. Superseded raw hashes remain historical.
        },
      },
    },
  };
}
function emitTokenSwapEvidenceOutbox(db,input){
  if(!enabled())return false;
  const event=buildTokenSwapEvidenceEvent(input);
  if(!event)return false;
  ensureSchema(db);
  const now=new Date(input.observedAt).toISOString();
  const result=db.prepare("INSERT OR IGNORE INTO outbox_events " +
    "(source_system,event_kind,event_key,schema_version,payload,created_at,next_attempt_at) " +
    "VALUES(?,?,?,?,?,?,?)").run(event.sourceSystem,event.eventKind,event.eventKey,
      event.schemaVersion,JSON.stringify(event.payload),now,now);
  return result.changes===1;
}
module.exports={enabled,buildTokenSwapEvidenceEvent,emitTokenSwapEvidenceOutbox};
