import {buildEntityRef, type EntityRef} from "./entity-registry.js";
import {toUtcIso} from "./time.js";
import type {EvidenceRef} from "./evidence.js";

export type TokenLinksInvalidation = {
  status:"invalidated";
  reason:"edited"|"deleted";
  sourceRevisionSha256:string;
};
export type TokenLinksInvalidatedEvent = {
  sourceSystem:"x"|"tg";
  eventKind:"token_links_invalidated";
  eventKey:string;
  schemaVersion:"token-link-v1";
  payload:{
    registryEvent:{
      sourceSystem:"x"|"tg";
      eventKind:"token_links_invalidated";
      eventKey:string;
      schemaVersion:"token-link-v1";
      entityRefs:EntityRef[];
      evidenceRef:EvidenceRef;
    };
    tokenLinksInvalidation:TokenLinksInvalidation;
  };
};
const HASH=/^[a-f0-9]{64}$/;

export function buildTokenLinksInvalidatedEvent(input:{
  sourceSystem:"x"|"tg";
  sourceEntity:EntityRef;
  evidenceRef:EvidenceRef;
  reason:"edited"|"deleted";
  sourceRevisionSha256:string;
}):TokenLinksInvalidatedEvent{
  if(input.sourceSystem!=="x"&&input.sourceSystem!=="tg")throw new TypeError("Unsupported invalidation source");
  if(input.reason!=="edited"&&input.reason!=="deleted")throw new TypeError("Invalid invalidation reason");
  if(!HASH.test(input.sourceRevisionSha256))throw new TypeError("Invalid revision SHA256");
  const ref=buildEntityRef(input.sourceEntity);
  const expectedKind=input.sourceSystem==="tg"?"source":"author";
  if(ref.kind!==expectedKind || !ref.canonicalId.startsWith(input.sourceSystem+":")){
    throw new TypeError("Invalid invalidation source entity");
  }
  const evidence=input.evidenceRef;
  if(!evidence || (input.sourceSystem==="tg"&&evidence.sourceKind!=="tg_message") ||
      (input.sourceSystem==="x"&&evidence.sourceKind!=="x_tweet")){
    throw new TypeError("Invalid invalidation evidence kind");
  }
  const validId=input.sourceSystem==="tg"
    ? /^tg:message:-?(?:0|[1-9][0-9]*):[1-9][0-9]*$/
    : /^x:tweet:[1-9][0-9]*$/;
  if(!validId.test(evidence.sourceId))throw new TypeError("Invalid invalidation evidence ID");
  const observedAt=toUtcIso(evidence.observedAt);
  const occurredAt=evidence.occurredAt===undefined?undefined:toUtcIso(evidence.occurredAt);
  const normalizedEvidence:EvidenceRef={...evidence,observedAt,
    ...(occurredAt===undefined?{}:{occurredAt})};
  const eventKey=`${input.sourceSystem}:tokenlinks:invalidate:${normalizedEvidence.sourceId}:${input.reason}:${input.sourceRevisionSha256}:${Date.parse(observedAt)}`;
  if(eventKey.length>512)throw new TypeError("Invalidation event key too long");
  const registryEvent={
    sourceSystem:input.sourceSystem,eventKind:"token_links_invalidated" as const,
    eventKey,schemaVersion:"token-link-v1" as const,
    entityRefs:[ref],evidenceRef:normalizedEvidence,
  };
  return {
    sourceSystem:input.sourceSystem,eventKind:"token_links_invalidated",
    eventKey,schemaVersion:"token-link-v1",
    payload:{
      registryEvent,
      tokenLinksInvalidation:{status:"invalidated",reason:input.reason,
        sourceRevisionSha256:input.sourceRevisionSha256},
    },
  };
}

/** Pure envelope consistency check; the source must prove edit/delete. */
export function validateTokenLinksInvalidatedEvent(input:unknown):TokenLinksInvalidatedEvent{
  if(!input||typeof input!=="object"||Array.isArray(input)){
    throw new TypeError("Invalid token link invalidation envelope");
  }
  const raw=input as TokenLinksInvalidatedEvent;
  if(raw.eventKind!=="token_links_invalidated"||raw.schemaVersion!=="token-link-v1"||
      !raw.payload?.registryEvent||!raw.payload?.tokenLinksInvalidation){
    throw new TypeError("Invalid token link invalidation");
  }
  const reg=raw.payload.registryEvent, inv=raw.payload.tokenLinksInvalidation;
  if(reg.sourceSystem!==raw.sourceSystem||reg.eventKind!==raw.eventKind||
      reg.eventKey!==raw.eventKey||reg.schemaVersion!==raw.schemaVersion||
      !Array.isArray(reg.entityRefs)||reg.entityRefs.length!==1||
      inv.status!=="invalidated"){
    throw new TypeError("Invalid link invalidation attribution");
  }
  const expected=buildTokenLinksInvalidatedEvent({
    sourceSystem:raw.sourceSystem,
    sourceEntity:reg.entityRefs[0]!,
    evidenceRef:reg.evidenceRef,
    reason:inv.reason,
    sourceRevisionSha256:inv.sourceRevisionSha256,
  });
  if(expected.eventKey!==raw.eventKey||
    JSON.stringify(expected.payload.registryEvent)!==JSON.stringify(reg)||
    JSON.stringify(expected.payload.tokenLinksInvalidation)!==JSON.stringify(inv)){
    throw new TypeError("Inconsistent link invalidation evidence");
  }
  return raw;
}
