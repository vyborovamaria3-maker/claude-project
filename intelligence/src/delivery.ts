import type { ClaimOptions, ClaimedEvent } from "@claude-project/event-outbox";
import type { TimelineEvent } from "@claude-project/contracts";
import { ingestRegistryEvent, validateRegistryEvent, type PgTransaction, type RegistryEvent } from "./entity-registry.js";
import { ingestTimelineEvent } from "./timeline.js";

export type OutboxSource = {
  claim(options: ClaimOptions): Promise<ClaimedEvent[]>;
  ack(event: ClaimedEvent): Promise<boolean>;
  fail(event: ClaimedEvent, reasonCode: string, nextAttemptAt: Date): Promise<boolean>;
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
  if (raw.timelineEvent !== undefined && raw.timelineEvent.eventKey !== event.eventKey) {
    throw new TypeError("Outbox envelope and timeline identities differ");
  }
  return {...raw, registryEvent: registry};
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
    try {
      const fresh=await writeDestination(destination,event);
      const acked=await source.ack(event);
      if (!acked) {
        stats.lostLeases++;
      } else if(fresh) {
        stats.delivered++;
      } else {
        stats.duplicates++;
      }
    } catch(error) {
      // Codes only: do not leak raw provider response, sessions, or credentials to source outbox.
      const code=error instanceof TypeError?"payload_invalid":"delivery_failed";
      stats.failed++;
      const next=new Date(Date.now()+retryDelayMs);
      try {if (!await source.fail(event,code,next)) stats.lostLeases++}
      catch {stats.lostLeases++}
    }
  }
  return stats;
}
