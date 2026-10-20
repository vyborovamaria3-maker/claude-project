import type { ClaimOptions, ClaimedEvent } from "@claude-project/event-outbox";
import { setTimeout as sleep } from "node:timers/promises";
import { buildTimelineEvent, toUtcIso, type TimelineEvent } from "@claude-project/contracts";
import { ingestRegistryEvent, validateRegistryEvent, type PgTransaction, type RegistryEvent } from "./entity-registry.js";
import { ingestTimelineEvent } from "./timeline.js";

export type OutboxSource = {
  claim(options: ClaimOptions): Promise<ClaimedEvent[]>;
  ack(event: ClaimedEvent): Promise<boolean>;
  fail(event: ClaimedEvent, reasonCode: string, nextAttemptAt: Date): Promise<boolean>;
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

export type RegistryOutboxPayload = {
  registryEvent: RegistryEvent;
  timelineEvent?: TimelineEvent;
};

/** Never trust payload envelope identity supplied by a source worker. */
function extractEnvelope(event: ClaimedEvent): RegistryOutboxPayload {
  if (typeof event.payload !== "object" || !event.payload ||
    !Object.hasOwn(event.payload, "registryEvent")) {
    throw new TypeError("Missing registryEvent payload");
  }
  const raw = event.payload as unknown as RegistryOutboxPayload;
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

/** The only transaction boundary: destination COMMIT BEFORE source ACK. */
async function writeDestination(
  pool: DestinationPool, event: ClaimedEvent,
): Promise<boolean> {
  const body=extractEnvelope(event);
  const client=await pool.connect();
  let open=false;
  try {
    await client.query("BEGIN"); open=true;
    const fresh=await ingestRegistryEvent(client,body.registryEvent);
    if (body.timelineEvent) {
      await ingestTimelineEvent(client,event.sourceSystem,event.eventKind,body.timelineEvent);
    }
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
      try {if (!await source.fail(active,code,next)) stats.lostLeases++}
      catch {stats.lostLeases++}
    }
  }
  return stats;
}
