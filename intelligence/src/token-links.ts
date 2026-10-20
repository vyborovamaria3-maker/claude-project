import {
  parseTokenId,toUtcIso,validateVerifiedTokenLinkEvent,
  validateTokenLinksInvalidatedEvent,type TokenId,
} from "@claude-project/contracts";
import type {PgTransaction} from "./entity-registry.js";

type LinkEnvelope={
  sourceSystem:"x"|"tg";eventKind:"token_link_verified"|"token_links_invalidated";
  eventKey:string;schemaVersion:"token-link-v1";payload:unknown;
};

/**
 * Destination transaction MUST already contain intelligence_inbox row.
 * On conflict, verify every material field; an event key cannot hide changed
 * mint attribution, clocks or proof after ACK loss / replay.
 */
export async function ingestTokenLinkObservation(tx:PgTransaction,input:LinkEnvelope):Promise<boolean>{
  let state:"verified"|"invalidated",token:string|null,revision:string,details:object,
      evidenceId:string,observedAt:string,occurredAt:string|null;
  if(input.eventKind==="token_link_verified"){
    const checked=validateVerifiedTokenLinkEvent(input);
    const evidence=checked.payload.registryEvent.evidenceRef;
    ({sourceId:evidenceId}=evidence);
    observedAt=evidence.observedAt;
    occurredAt=evidence.occurredAt??null;
    token=checked.payload.tokenLink.canonicalTokenId;
    revision=checked.payload.tokenLink.sourceRevisionSha256;
    details=checked.payload.tokenLink;
    state="verified";
  }else if(input.eventKind==="token_links_invalidated"){
    const checked=validateTokenLinksInvalidatedEvent(input);
    const evidence=checked.payload.registryEvent.evidenceRef;
    evidenceId=evidence.sourceId;
    observedAt=evidence.observedAt;
    occurredAt=evidence.occurredAt??null;
    token=null;
    revision=checked.payload.tokenLinksInvalidation.sourceRevisionSha256;
    details=checked.payload.tokenLinksInvalidation;
    state="invalidated";
  }else throw new TypeError("Unsupported link observation");
  const params=[
    input.sourceSystem,input.eventKind,input.eventKey,evidenceId,
    token,state,observedAt,occurredAt,revision,JSON.stringify(details),
  ];
  const result=await tx.query(`INSERT INTO token_link_observations
    (source_system,event_kind,event_key,evidence_source_id,canonical_token_id,
     state,observed_at,occurred_at,source_revision_sha256,details)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
    ON CONFLICT(source_system,event_kind,event_key) DO NOTHING
    RETURNING event_key`,params);
  if(result.rows.length>0)return true;
  // PostgreSQL JSONB equality ignores key order. Replay must be bitwise
  // semantically the same record even if its original inbox already exists.
  const previous=await tx.query(`SELECT event_key FROM token_link_observations
    WHERE source_system=$1 AND event_kind=$2 AND event_key=$3
      AND evidence_source_id=$4 AND canonical_token_id IS NOT DISTINCT FROM $5::text
      AND state=$6 AND observed_at=$7::timestamptz
      AND occurred_at IS NOT DISTINCT FROM $8::timestamptz
      AND source_revision_sha256=$9 AND details=$10::jsonb`,params);
  if(previous.rows.length!==1)throw new TypeError("Token link event identity collision");
  return false;
}

/** Current-as-known-by-T linked social evidence, excluding later corrections. */
export async function queryActiveTokenLinks(
  tx:PgTransaction,tokenId:TokenId,occurredBefore:Date|string,knownAt:Date|string,limit=100,
):Promise<Record<string,unknown>[]>{
  if(parseTokenId(tokenId)?.id!==tokenId)throw new TypeError("Noncanonical token ID");
  if(!Number.isSafeInteger(limit)||limit<1||limit>500)throw new RangeError("limit 1..500 required");
  const result=await tx.query(`WITH latest AS (
    SELECT DISTINCT ON (v.source_system,v.evidence_source_id)
      v.source_system,v.evidence_source_id,v.event_key,v.canonical_token_id,
      v.observed_at,v.occurred_at,v.source_revision_sha256,v.details
    FROM token_link_observations v
    WHERE v.state='verified' AND v.canonical_token_id=$1
      AND v.observed_at<=$3::timestamptz
      AND COALESCE(v.occurred_at,v.observed_at)<=$2::timestamptz
    ORDER BY v.source_system,v.evidence_source_id,v.observed_at DESC,v.event_key DESC
  )
  SELECT v.* FROM latest v
  WHERE NOT EXISTS (
    SELECT 1 FROM token_link_observations inv
    WHERE inv.source_system=v.source_system
      AND inv.evidence_source_id=v.evidence_source_id
      AND inv.state='invalidated'
      AND inv.observed_at >= v.observed_at
      AND inv.observed_at <= $3::timestamptz
  )
  ORDER BY v.observed_at DESC,v.source_system,v.evidence_source_id
  LIMIT $4`,[tokenId,toUtcIso(occurredBefore),toUtcIso(knownAt),limit]);
  return result.rows;
}
