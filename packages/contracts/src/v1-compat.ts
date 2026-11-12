import { buildEntityRef, type EntityKind } from "./entity-registry.js";
import { validateEvidenceRef } from "./evidence.js";
import { buildEventEnvelopeV2, type EventEnvelopeV2, type EventSource } from "./event-envelope.js";
import { validateRegisteredPayload } from "./schema-registry.js";
import { toUtcIso } from "./time.js";

/** The V1 shape persisted by the existing X, TG and Solana source outboxes. */
export type LegacyOutboxEvent = Readonly<{
  sourceSystem: EventSource;
  eventKind: string;
  eventKey: string;
  schemaVersion: string;
  payload: Record<string, unknown>;
}>;

export type LegacyV1AdapterOptions = Readonly<{
  /**
   * Must be the source outbox row's immutable created_at value.
   * Claimed V1 event payloads do not carry emittedAt; do not substitute
   * observedAt or destination ingestion time.
   */
  emittedAt: Date | string;
  /**
   * V1 rows do not record the producer build. The explicit legacy marker
   * preserves that uncertainty instead of inventing a release identifier.
   */
  producerVersion?: string;
}>;

/**
 * Normalize a registered V1 source event into the V2 envelope without
 * rewriting the source payload or changing its event/evidence identity.
 * Only the three supported evidence sources are accepted; twitter_research
 * and unknown event schemas remain outside this V2 contract.
 */
export function adaptLegacyOutboxEventToV2(
  eventValue: LegacyOutboxEvent,
  options: LegacyV1AdapterOptions,
): EventEnvelopeV2 {
  if (!eventValue || typeof eventValue !== "object" || Array.isArray(eventValue)) {
    throw new TypeError("Invalid legacy outbox event");
  }
  const event = eventValue as LegacyOutboxEvent;
  if (!["x", "tg", "blockchain"].includes(event.sourceSystem)) {
    throw new TypeError("Unsupported legacy sourceSystem");
  }
  if (typeof event.eventKind !== "string" || !event.eventKind.trim() ||
      typeof event.eventKey !== "string" || !event.eventKey.trim() ||
      typeof event.schemaVersion !== "string" || !event.schemaVersion.trim()) {
    throw new TypeError("Invalid legacy event identity");
  }
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    throw new TypeError("Legacy payload must be an object");
  }
  if (!options || options.emittedAt === undefined) {
    throw new TypeError("Source outbox created_at is required for V1 adaptation");
  }

  const identity = {
    sourceSystem: event.sourceSystem,
    eventKind: event.eventKind,
    eventKey: event.eventKey,
    schemaVersion: event.schemaVersion,
  };
  const definition = validateRegisteredPayload(identity, event.payload);
  const payload = event.payload as Record<string, unknown>;
  const registryEvent = payload.registryEvent as Record<string, unknown>;
  const evidenceRef = validateEvidenceRef(registryEvent.evidenceRef);
  const rawEntityRefs = registryEvent.entityRefs;
  if (!Array.isArray(rawEntityRefs)) {
    throw new TypeError("Legacy registry event requires entityRefs");
  }
  const entityRefs = rawEntityRefs.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Invalid legacy entity reference");
    }
    const ref = value as Record<string, unknown>;
    const normalized = buildEntityRef({
      kind: ref.kind as EntityKind,
      canonicalId: String(ref.canonicalId ?? ""),
      firstSeenAt: String(ref.firstSeenAt ?? ""),
      lastSeenAt: String(ref.lastSeenAt ?? ""),
    });
    return { kind: normalized.kind, canonicalId: normalized.canonicalId };
  });

  const producerVersion = options.producerVersion === undefined
    ? "legacy-v1"
    : options.producerVersion;
  if (typeof producerVersion !== "string" || !producerVersion.trim() || producerVersion.length > 128) {
    throw new TypeError("Invalid producerVersion");
  }

  return buildEventEnvelopeV2({
    sourceSystem: event.sourceSystem,
    eventKind: event.eventKind,
    eventKey: event.eventKey,
    schemaVersion: event.schemaVersion,
    producer: {
      name: definition.producerName,
      version: producerVersion,
    },
    clocks: {
      occurredAt: evidenceRef.occurredAt ?? null,
      observedAt: evidenceRef.observedAt,
      emittedAt: toUtcIso(options.emittedAt),
    },
    entityRefs,
    evidenceRefs: [evidenceRef],
    payload,
  });
}

/** Short alias for consumers that describe the adapter as a V1 normalizer. */
export const normalizeV1OutboxEvent = adaptLegacyOutboxEventToV2;
