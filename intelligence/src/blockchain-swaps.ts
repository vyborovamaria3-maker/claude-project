import {parseTokenId,toUtcIso,type TokenId} from "@claude-project/contracts";
import {validateRegistryEvent,type PgTransaction,type RegistryEvent} from "./entity-registry.js";

/**
 * ARCH-06b: a wallet-specific, provider-parsed raw-revision state.
 * Unsupported means "this raw revision does not support the old mint claim",
 * not proof that the swap never happened, reorg finality or realized PnL.
 */
type RevisionState="supported"|"unsupported";
type Revision={
  walletId:string;signature:string;rawRevision:number;rawSha256:string;
  status:RevisionState;canonicalTokenId:string|null;slot:number|null;
};
type RevisionEnvelope={
  sourceSystem:string;eventKind:string;eventKey:string;schemaVersion:string;
  payload:{registryEvent:RegistryEvent;timelineEvent?:unknown;swapRevision?:unknown};
};

function checkedRevision(input:RevisionEnvelope):{
  state:Revision;observedAt:string;occurredAt:string|null;
}{
  if(input.sourceSystem!=="blockchain"||
     input.eventKind!=="token_swap_evidence_revision"||
     input.schemaVersion!=="chain-token-revision-v1"||
     input.payload.timelineEvent!==undefined)
    throw new TypeError("Unsupported Blockchain revision envelope");
  const registry=validateRegistryEvent(input.payload.registryEvent);
  if(registry.sourceSystem!==input.sourceSystem||
     registry.eventKind!==input.eventKind||
     registry.eventKey!==input.eventKey||
     registry.schemaVersion!==input.schemaVersion||
     registry.entityRefs.length!==1||
     registry.entityRefs[0]?.kind!=="wallet")
    throw new TypeError("Blockchain revision registry mismatch");
  const raw=input.payload.swapRevision;
  if(!raw||typeof raw!=="object"||Array.isArray(raw))
    throw new TypeError("Missing swap revision");
  const fields=Object.keys(raw).sort().join(",");
  if(fields!=="canonicalTokenId,rawRevision,rawSha256,signature,slot,status,walletId")
    throw new TypeError("Unexpected swap revision fields");
  const state=raw as Revision;
  if(typeof state.walletId!=="string"||
     state.walletId!==registry.entityRefs[0].canonicalId||
     !state.walletId.startsWith("solana:")||
     typeof state.signature!=="string"||
     registry.evidenceRef.sourceId!=="chain:tx:solana:"+state.signature||
     registry.evidenceRef.parserVersion!=="chain-swap-revision-1"||
     !Number.isSafeInteger(state.rawRevision)||state.rawRevision<1||
     typeof state.rawSha256!=="string"||!/^[a-f0-9]{64}$/.test(state.rawSha256))
    throw new TypeError("Invalid swap revision identity");
  const expected="chain:wallet:"+state.walletId.slice(7)+
    ":signature:"+state.signature+":raw-revision:"+state.rawRevision+
    ":sha256:"+state.rawSha256+":parser:1";
  if(input.eventKey!==expected)throw new TypeError("Swap revision key mismatch");
  const observedAt=toUtcIso(registry.evidenceRef.observedAt);
  let occurredAt:string|null=null;
  if(state.status==="supported"){
    if(typeof state.canonicalTokenId!=="string"||
       !state.canonicalTokenId.startsWith("solana:")||
       parseTokenId(state.canonicalTokenId)?.id!==state.canonicalTokenId||
       !Number.isSafeInteger(state.slot)||state.slot===null||state.slot<1||
       !registry.evidenceRef.occurredAt)
      throw new TypeError("Unsupported mint claim or missing occurredAt");
    occurredAt=toUtcIso(registry.evidenceRef.occurredAt);
    if(occurredAt>observedAt)
      throw new TypeError("Future-dated provider swap");
  }else if(state.status==="unsupported"){
    if(state.canonicalTokenId!==null||state.slot!==null||
       registry.evidenceRef.occurredAt!==undefined)
      throw new TypeError("Unsupported raw revision cannot assert a token or slot");
  }else throw new TypeError("Invalid revision status");
  return {state,observedAt,occurredAt};
}

/** One destination PG transaction with the inbox insert, before source ACK. */
export async function ingestBlockchainSwapRevision(
  tx:PgTransaction,input:RevisionEnvelope,
):Promise<boolean>{
  const {state,observedAt,occurredAt}=checkedRevision(input);
  const params=[
    input.sourceSystem,input.eventKind,input.eventKey,
    state.walletId,state.signature,state.rawRevision,state.rawSha256,
    state.status,state.canonicalTokenId,state.slot,observedAt,occurredAt,
    JSON.stringify(state),
  ];
  const inserted=await tx.query(`INSERT INTO blockchain_swap_evidence_revisions
    (source_system,event_kind,event_key,wallet_id,signature,raw_revision,
     raw_sha256,state,canonical_token_id,slot,observed_at,occurred_at,details)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
    ON CONFLICT(source_system,event_kind,event_key) DO NOTHING
    RETURNING event_key`,params);
  if(inserted.rows.length>0)return true;
  const previous=await tx.query(`SELECT event_key FROM blockchain_swap_evidence_revisions
    WHERE source_system=$1 AND event_kind=$2 AND event_key=$3
      AND wallet_id=$4 AND signature=$5 AND raw_revision=$6
      AND raw_sha256=$7 AND state=$8
      AND canonical_token_id IS NOT DISTINCT FROM $9::text
      AND slot IS NOT DISTINCT FROM $10::bigint
      AND observed_at=$11::timestamptz
      AND occurred_at IS NOT DISTINCT FROM $12::timestamptz
      AND details=$13::jsonb`,params);
  if(previous.rows.length!==1)
    throw new TypeError("Blockchain swap revision identity collision");
  return false;
}

/**
 * Only CURRENT supported evidence as known at T. The latest rawRevision
 * (not delivery order) for each wallet+signature controls active attribution.
 * DISTINCT by signature+token suppresses duplicate observed wallet perspectives
 * for this token, but does NOT imply complete cross-DEX trade dedup or PnL.
 * Legacy ARCH-06a timeline observations are deliberately NOT promoted here.
 */
export async function queryActiveBlockchainSwapEvidence(
  tx:PgTransaction,tokenId:TokenId,occurredBefore:Date|string,
  knownAt:Date|string,limit=100,
):Promise<Record<string,unknown>[]>{
  if(!tokenId.startsWith("solana:")||parseTokenId(tokenId)?.id!==tokenId)
    throw new TypeError("Noncanonical Solana token");
  if(!Number.isSafeInteger(limit)||limit<1||limit>500)
    throw new RangeError("limit 1..500 required");
  const result=await tx.query(`WITH latest AS (
    SELECT DISTINCT ON (wallet_id,signature) wallet_id,signature,raw_revision,
      canonical_token_id,state,slot,occurred_at,observed_at
    FROM blockchain_swap_evidence_revisions
    WHERE observed_at<=$3::timestamptz
    ORDER BY wallet_id,signature,raw_revision DESC
  ), deduplicated AS (
    SELECT DISTINCT ON (signature,canonical_token_id)
      signature,canonical_token_id,wallet_id,slot,occurred_at,observed_at,raw_revision
    FROM latest
    WHERE state='supported' AND canonical_token_id=$1
      AND occurred_at<=$2::timestamptz
    ORDER BY signature,canonical_token_id,wallet_id
  )
  SELECT * FROM deduplicated
  ORDER BY occurred_at DESC,signature
  LIMIT $4`,[tokenId,toUtcIso(occurredBefore),toUtcIso(knownAt),limit]);
  return result.rows;
}
