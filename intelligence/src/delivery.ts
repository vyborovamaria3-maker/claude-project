import type { ClaimOptions, ClaimedEvent } from "@claude-project/event-outbox";
import { setTimeout as sleep } from "node:timers/promises";
import { buildTimelineEvent, toUtcIso, validateVerifiedTokenLinkEvent, validateTokenLinksInvalidatedEvent, type TimelineEvent } from "@claude-project/contracts";
import { ingestRegistryEvent, validateRegistryEvent, type PgTransaction, type RegistryEvent } from "./entity-registry.js";
import { ingestTimelineEvent } from "./timeline.js";
import { ingestTokenLinkObservation } from "./token-links.js";
import { ingestBlockchainSwapRevision } from "./blockchain-swaps.js";
import {queueAnalyticsInvalidation} from "./governance.js";

export type OutboxSource = {
  claim(options: ClaimOptions): Promise<ClaimedEvent[]>;
  ack(event: ClaimedEvent): Promise<boolean>;
  fail(event: ClaimedEvent, reasonCode: string, nextAttemptAt: Date, retryDelayMs?: number): Promise<boolean>;
  /** Optional: exchange an exact active claim for a new lease fencing token. */
  renew?(event: ClaimedEvent, leaseMs: number): Promise<string | null>;
};

export type DestinationClient = PgTransaction & { release(): void };
export type DestinationPool = { connect(): Promise<DestinationClient> };

export type DeliveryStats = {
  claimed: number;
  delivered: number;
  duplicates: number;
  failed: number;
  lostLeases: number;
};

type DeliveryEvent = Pick<ClaimedEvent,"sourceSystem"|"eventKind"|"eventKey"|"schemaVersion"|"payload">;

export type RegistryOutboxPayload = {
  registryEvent: RegistryEvent;
  timelineEvent?: TimelineEvent;
};

/** Never trust payload envelope identity supplied by a source worker. */
function extractEnvelope(event: DeliveryEvent): RegistryOutboxPayload {
  if (typeof event.payload !== "object" || !event.payload ||
    !Object.hasOwn(event.payload, "registryEvent")) {
    throw new TypeError("Missing registryEvent payload");
  }
  const raw = event.payload as unknown as RegistryOutboxPayload;
  // Verified link assertions must not be silently ignored by a generic inbox.
  // This checks proof structure; it cannot replace the source-side RPC check.
  if(event.eventKind==="token_link_verified" || event.eventKind==="token_links_invalidated") {
    // A historical assertion/invalidation is never a generic timeline row.
    if(raw.timelineEvent!==undefined)throw new TypeError("Token links have no timelineEvent");
    const full={
      sourceSystem:event.sourceSystem,eventKind:event.eventKind,
      eventKey:event.eventKey,schemaVersion:event.schemaVersion,payload:raw,
    };
    if(event.eventKind==="token_link_verified")validateVerifiedTokenLinkEvent(full);
    else validateTokenLinksInvalidatedEvent(full);
  }
  const registry = validateRegistryEvent(raw.registryEvent);
  if (registry.sourceSystem !== event.sourceSystem ||
    registry.eventKind !== event.eventKind ||
    registry.eventKey !== event.eventKey ||
    registry.schemaVersion !== event.schemaVersion) {
    throw new TypeError("Outbox envelope and registry identities differ");
  }
  if (raw.timelineEvent === undefined) return {...raw, registryEvent: registry};
  const candidate = raw.timelineEvent;
  if (!candidate || typeof candidate !== "object") {
    throw new TypeError("Invalid timeline payload");
  }
  const timeline=buildTimelineEvent(candidate);
  if (timeline.eventKey !== event.eventKey) {
    throw new TypeError("Outbox envelope and timeline identities differ");
  }
  const registryEvidence=registry.evidenceRef, timelineEvidence=timeline.evidenceRef;
  for (const field of ["sourceKind","sourceId","parserVersion","provider","rawPointer"] as const) {
    if (registryEvidence[field] !== timelineEvidence[field]) {
      throw new TypeError("Registry and timeline evidence disagree: "+field);
    }
  }
  const observedAt=toUtcIso(registryEvidence.observedAt);
  const occurredAt=toUtcIso(registryEvidence.occurredAt ?? registryEvidence.observedAt);
  if (timeline.observedAt !== observedAt ||
      toUtcIso(timelineEvidence.observedAt) !== observedAt ||
      timeline.occurredAt !== occurredAt ||
      (timelineEvidence.occurredAt === undefined) !==
        (registryEvidence.occurredAt === undefined) ||
      (timelineEvidence.occurredAt !== undefined &&
        toUtcIso(timelineEvidence.occurredAt) !== occurredAt)) {
    throw new TypeError("Registry and timeline evidence clocks disagree");
  }
  const identities = (refs: typeof registry.entityRefs) =>
    refs.map(ref=>[ref.kind,ref.canonicalId,ref.firstSeenAt,ref.lastSeenAt].join("|"))
      .sort();
  if (JSON.stringify(identities(registry.entityRefs)) !==
      JSON.stringify(identities(timeline.entityRefs))) {
    throw new TypeError("Registry and timeline entity references disagree");
  }
  return {...raw, registryEvent: registry, timelineEvent: timeline};
}

/**
 * Optional additive migration 010 hook. Revisions and link retractions enqueue
 * recomputation for previously evidence-linked tokens, but never guess tokens
 * from source content. The queued work is audited; a separate backfill-aware
 * worker must compute/publish the new historical snapshot.
 */
async function queueAffectedTokensForRecalculation(
  tx:PgTransaction,event:DeliveryEvent,body:RegistryOutboxPayload,
):Promise<void> {
  if(!["x","tg"].includes(event.sourceSystem))return;
  if(!["tweet_observed","message_observed","message_deleted",
      "token_link_verified","token_links_invalidated"].includes(event.eventKind))return;
  const present=await tx.query("SELECT to_regclass('analytics_invalidation_queue') IS NOT NULL AS ready");
  if(present.rows[0]?.ready!==true)return; // Staged migration: old collectors remain backward-compatible.
  const evidenceRef=body.registryEvent.evidenceRef.sourceId;
  const previous=await tx.query(`SELECT DISTINCT canonical_token_id FROM token_link_observations
    WHERE source_system=$1 AND evidence_source_id=$2 AND state='verified'
      AND canonical_token_id IS NOT NULL
    UNION SELECT entity.canonical_id FROM timeline_events timeline
      JOIN timeline_event_entities entity ON entity.source_system=timeline.source_system
        AND entity.source_event_kind=timeline.source_event_kind AND entity.event_key=timeline.event_key
      WHERE timeline.source_system=$1 AND timeline.evidence_source_id=$2 AND entity.kind='token'`,[event.sourceSystem,evidenceRef]);
  const tokens=new Set(previous.rows.map(row=>String(row.canonical_token_id)));
  if(event.eventKind==="token_link_verified") {
    const payload=event.payload as Record<string,unknown>;
    const link=payload.tokenLink;
    if(link && typeof link==="object" && typeof (link as Record<string,unknown>).canonicalTokenId==="string")
      tokens.add((link as {canonicalTokenId:string}).canonicalTokenId);
  }
  const reason=event.eventKind==="token_links_invalidated"?"link_invalidated":
    event.eventKind==="message_deleted"?"delete":
    event.eventKind==="token_link_verified"?"backfill":"edit";
  for(const canonicalTokenId of tokens)
    await queueAnalyticsInvalidation(tx,{
      canonicalTokenId,sourceSystem:event.sourceSystem as "x"|"tg",
      eventKind:event.eventKind,eventKey:event.eventKey,reason,
    });
}

/** Revoke stored social ciphertext in the same destination transaction as a
 * verified deletion/edit tombstone. Older migration versions keep working. */
async function revokeRetiredTextSnapshots(
  tx:PgTransaction,event:DeliveryEvent,body:RegistryOutboxPayload,
):Promise<void> {
  if(!["x","tg"].includes(event.sourceSystem)||
     !["message_deleted","token_links_invalidated"].includes(event.eventKind))return;
  const present=await tx.query("SELECT to_regclass('event_text_snapshots') IS NOT NULL AS ready");
  if(present.rows[0]?.ready!==true)return;
  await tx.query(`UPDATE event_text_snapshots s
    SET text_ciphertext=NULL,purged_at=clock_timestamp()
    FROM intelligence_inbox original
    WHERE original.source_system=$1 AND original.evidence_source_id=$2
      AND s.source_system=original.source_system
      AND s.source_event_kind=original.event_kind
      AND s.event_key=original.event_key AND s.purged_at IS NULL`,[
      event.sourceSystem,body.registryEvent.evidenceRef.sourceId,
    ]);
}
/** Reuse delivery's privacy/invalidation hooks for read-only legacy source
 * snapshots. Caller owns the transaction, including its durable watch cursor. */
export async function ingestDestinationEvent(tx:PgTransaction,event:DeliveryEvent):Promise<boolean>{
  const body=extractEnvelope(event);
  const fresh=await ingestRegistryEvent(tx,body.registryEvent);
  if(event.eventKind==="token_link_verified"||event.eventKind==="token_links_invalidated"){
    await ingestTokenLinkObservation(tx,{
      sourceSystem:event.sourceSystem as "x"|"tg",
      eventKind:event.eventKind,eventKey:event.eventKey,
      schemaVersion:"token-link-v1",payload:event.payload,
    });
  }
  if(event.eventKind==="token_swap_evidence_revision"){
    await ingestBlockchainSwapRevision(tx,{
      sourceSystem:event.sourceSystem,eventKind:event.eventKind,
      eventKey:event.eventKey,schemaVersion:event.schemaVersion,payload:body,
    });
  }
  if (body.timelineEvent) {
    await ingestTimelineEvent(tx,event.sourceSystem,event.eventKind,body.timelineEvent);
  }
  if(fresh){
    await revokeRetiredTextSnapshots(tx,event,body);
    await queueAffectedTokensForRecalculation(tx,event,body);
  }
  return fresh;
}

/** The only transaction boundary: destination COMMIT BEFORE source ACK. */
async function writeDestination(
  pool: DestinationPool, event: ClaimedEvent,
): Promise<boolean> {
  extractEnvelope(event); // Reject malformed source data before borrowing a connection.
  const client=await pool.connect();
  let open=false;
  try {
    await client.query("BEGIN"); open=true;
    const fresh=await ingestDestinationEvent(client,event);
    await client.query("COMMIT");open=false;
    return fresh;
  } catch(error) {
    if (open) {try {await client.query("ROLLBACK")}catch {/* first error wins */}}
    throw error;
  } finally {client.release();}
}

/**
 * One bounded batch; scheduler / process supervision belongs to the host.
 * No source or destination connection is held while waiting for future work.
 */
export async function runDeliveryBatch(
  source: OutboxSource,
  destination: DestinationPool,
  options: ClaimOptions,
  retryDelayMs=30_000,
): Promise<DeliveryStats> {
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 1000 || retryDelayMs > 3_600_000) {
    throw new RangeError("Invalid retryDelayMs");
  }
  const claimed=await source.claim(options);
  if (claimed.length > options.batchSize) throw new Error("Source returned oversized claim");
  const stats: DeliveryStats={claimed:claimed.length,delivered:0,duplicates:0,failed:0,lostLeases:0};
  for (const event of claimed) {
    let active: ClaimedEvent=event;
    let lostDuringRenewal=false;
    const stop=new AbortController();
    // Each renewal is awaited: never let two renewals race with each other or
    // with the final ACK/NACK. The supervisor claims batchSize=1 so unstarted
    // events cannot expire while waiting behind another slow destination write.
    const heartbeat: Promise<void>=source.renew ? (async()=>{
      while(!stop.signal.aborted){
        try{
          await sleep(Math.max(250,Math.floor(options.leaseMs/3)),undefined,{signal:stop.signal});
        }catch{break}
        if(stop.signal.aborted)break;
        try{
          const next=await source.renew!(active,options.leaseMs);
          if(!next || !Number.isFinite(Date.parse(next))){
            lostDuringRenewal=true;
            break;
          }
          active={...active,leaseUntil:next};
        }catch{
          // A destination COMMIT may already be in progress. Never ACK with
          // an uncertain lease: a later source replay is safe and idempotent.
          lostDuringRenewal=true;
          break;
        }
      }
    })() : Promise.resolve();
    const finish=async()=>{stop.abort();await heartbeat};
    try {
      const fresh=await writeDestination(destination,event);
      await finish();
      if(lostDuringRenewal){
        stats.lostLeases++;
        continue;
      }
      const acked=await source.ack(active);
      if (!acked) {
        stats.lostLeases++;
      } else if(fresh) {
        stats.delivered++;
      } else {
        stats.duplicates++;
      }
    } catch(error) {
      await finish();
      // Codes only: do not leak raw provider response, sessions, or credentials to source outbox.
      const code=error instanceof TypeError?"payload_invalid":"delivery_failed";
      stats.failed++;
      if(lostDuringRenewal){
        stats.lostLeases++;
        continue;
      }
      const next=new Date(Date.now()+retryDelayMs);
      try {if (!await source.fail(active,code,next,retryDelayMs)) stats.lostLeases++}
      catch {stats.lostLeases++}
    }
  }
  return stats;
}
