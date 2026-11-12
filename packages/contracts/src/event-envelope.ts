import { canonicalJsonStringify, sha256Canonical } from "./canonical-json.js";
import { buildEntityRef, type EntityKind } from "./entity-registry.js";
import { validateEvidenceRef, type EvidenceRef, type EvidenceSourceKind } from "./evidence.js";
import { toUtcIso } from "./time.js";
import {
  getSchemaDefinition, validateJsonSchema, validateRegisteredPayload,
  type EventSource, type JsonSchema,
} from "./schema-registry.js";

export type EventEntityRef = Readonly<{
  kind: EntityKind;
  canonicalId: string;
}>;

export type EventEvidenceRef = Readonly<EvidenceRef & {
  contentSha256?: string;
}>;

export type EventCoverageRef = Readonly<{
  sourceSystem: EventSource;
  scope: string;
  windowStart: string;
  windowEnd: string;
  status: "complete" | "partial" | "unknown";
  coverageId: string;
}>;

export type EventEnvelopeV2<TPayload extends Record<string, unknown> = Record<string, unknown>> =
  Readonly<{
    envelopeVersion: "event-envelope-v2";
    eventId: string;
    sourceSystem: EventSource;
    eventKind: string;
    eventKey: string;
    schemaVersion: string;
    producer: Readonly<{ name: string; version: string }>;
    clocks: Readonly<{
      occurredAt: string | null;
      observedAt: string;
      emittedAt: string;
    }>;
    entityRefs: readonly EventEntityRef[];
    evidenceRefs: readonly EventEvidenceRef[];
    coverageRef?: EventCoverageRef;
    payload: TPayload;
    payloadSha256: string;
  }>;

export type EventEnvelopeV2Input<TPayload extends Record<string, unknown> = Record<string, unknown>> =
  Readonly<{
    sourceSystem: EventSource;
    eventKind: string;
    eventKey: string;
    schemaVersion: string;
    producer: Readonly<{ name: string; version: string }>;
    clocks: Readonly<{
      occurredAt: string | null;
      observedAt: string;
      emittedAt: string;
    }>;
    entityRefs: readonly EventEntityRef[];
    evidenceRefs: readonly EventEvidenceRef[];
    coverageRef?: EventCoverageRef;
    payload: TPayload;
  }>;

export const EVENT_ENVELOPE_V2_JSON_SCHEMA: JsonSchema = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.potapoff.local/event-envelope-v2.schema.json",
  title: "POTAPoff Event Envelope V2",
  type: "object",
  required: [
    "envelopeVersion", "eventId", "sourceSystem", "eventKind", "eventKey",
    "schemaVersion", "producer", "clocks", "entityRefs", "evidenceRefs",
    "payload", "payloadSha256",
  ],
  additionalProperties: false,
  properties: {
    envelopeVersion: { const: "event-envelope-v2" },
    eventId: { type: "string", pattern: "^evt_v2_[a-f0-9]{64}$" },
    sourceSystem: { type: "string", enum: ["x", "tg", "blockchain"] },
    eventKind: { type: "string", minLength: 1, maxLength: 512 },
    eventKey: { type: "string", minLength: 1, maxLength: 512 },
    schemaVersion: { type: "string", minLength: 1, maxLength: 128 },
    producer: {
      type: "object",
      required: ["name", "version"],
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 1, maxLength: 128 },
        version: { type: "string", minLength: 1, maxLength: 128 },
      },
    },
    clocks: {
      type: "object",
      required: ["occurredAt", "observedAt", "emittedAt"],
      additionalProperties: false,
      properties: {
        occurredAt: { type: ["string", "null"], maxLength: 40 },
        observedAt: { type: "string", minLength: 20, maxLength: 40 },
        emittedAt: { type: "string", minLength: 20, maxLength: 40 },
      },
    },
    entityRefs: {
      type: "array",
      minItems: 1,
      maxItems: 200,
      items: {
        type: "object",
        required: ["kind", "canonicalId"],
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["token", "wallet", "author", "source"] },
          canonicalId: { type: "string", minLength: 1, maxLength: 512 },
        },
      },
    },
    evidenceRefs: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: {
        type: "object",
        required: ["sourceKind", "sourceId", "observedAt"],
        additionalProperties: false,
        properties: {
          sourceKind: { type: "string", enum: ["x_tweet", "tg_message", "chain_tx"] },
          sourceId: { type: "string", minLength: 1, maxLength: 512 },
          observedAt: { type: "string", minLength: 20, maxLength: 40 },
          occurredAt: { type: "string", minLength: 20, maxLength: 40 },
          provider: { type: "string", minLength: 1, maxLength: 4096 },
          parserVersion: { type: "string", minLength: 1, maxLength: 4096 },
          rawPointer: { type: "string", minLength: 1, maxLength: 4096 },
          contentSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        },
      },
    },
    coverageRef: {
      type: "object",
      required: ["sourceSystem", "scope", "windowStart", "windowEnd", "status", "coverageId"],
      additionalProperties: false,
      properties: {
        sourceSystem: { type: "string", enum: ["x", "tg", "blockchain"] },
        scope: { type: "string", minLength: 1, maxLength: 512 },
        windowStart: { type: "string", minLength: 20, maxLength: 40 },
        windowEnd: { type: "string", minLength: 20, maxLength: 40 },
        status: { type: "string", enum: ["complete", "partial", "unknown"] },
        coverageId: { type: "string", minLength: 1, maxLength: 512 },
      },
    },
    payload: { type: "object" },
    payloadSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
  },
});

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Expected object: " + label);
  }
  return value as Record<string, unknown>;
}

function nonempty(value: unknown, label: string, maxLength = 512): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new TypeError("Invalid " + label);
  }
  return value;
}

function createEventId(sourceSystem: EventSource, eventKind: string, eventKey: string): string {
  return "evt_v2_" + sha256Canonical([sourceSystem, eventKind, eventKey]);
}

function normalizeEntityRefs(value: unknown, observedAt: string): EventEntityRef[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 200) {
    throw new TypeError("Event requires 1..200 entityRefs");
  }
  const seen = new Set<string>();
  return value.map((item) => {
    const ref = record(item, "entityRef");
    const kind = ref.kind as EntityKind;
    const canonicalId = nonempty(ref.canonicalId, "entity canonicalId");
    const normalized = buildEntityRef({
      kind, canonicalId, firstSeenAt: observedAt, lastSeenAt: observedAt,
    });
    const key = normalized.kind + ":" + normalized.canonicalId;
    if (seen.has(key)) throw new TypeError("Duplicate entityRef: " + key);
    seen.add(key);
    return Object.freeze({ kind: normalized.kind, canonicalId: normalized.canonicalId });
  });
}

function normalizeEvidenceRefs(value: unknown, sourceSystem: EventSource): EventEvidenceRef[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new TypeError("Event requires 1..100 evidenceRefs");
  }
  const expected: Record<EventSource, EvidenceSourceKind> = {
    x: "x_tweet", tg: "tg_message", blockchain: "chain_tx",
  };
  return value.map((item) => {
    const raw = record(item, "evidenceRef");
    const allowed = new Set([
      "sourceKind", "sourceId", "observedAt", "occurredAt",
      "provider", "parserVersion", "rawPointer", "contentSha256",
    ]);
    for (const key of Object.keys(raw)) {
      if (!allowed.has(key)) throw new TypeError("Unknown evidenceRef field: " + key);
    }
    if (raw.contentSha256 !== undefined &&
        (typeof raw.contentSha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.contentSha256))) {
      throw new TypeError("Invalid evidence contentSha256");
    }
    const { contentSha256, ...base } = raw;
    const evidence = validateEvidenceRef(base);
    if (evidence.sourceKind !== expected[sourceSystem]) {
      throw new TypeError("Evidence source kind does not match event source");
    }
    return Object.freeze({
      ...evidence,
      ...(contentSha256 === undefined ? {} : { contentSha256: contentSha256 as string }),
    });
  });
}

function normalizeCoverageRef(value: unknown, sourceSystem: EventSource): EventCoverageRef {
  const raw = record(value, "coverageRef");
  const allowed = new Set(["sourceSystem", "scope", "windowStart", "windowEnd", "status", "coverageId"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new TypeError("Unknown coverageRef field: " + key);
  }
  if (raw.sourceSystem !== sourceSystem) throw new TypeError("Coverage source does not match event source");
  if (!["complete", "partial", "unknown"].includes(String(raw.status))) {
    throw new TypeError("Invalid coverage status");
  }
  const windowStart = toUtcIso(String(raw.windowStart ?? ""));
  const windowEnd = toUtcIso(String(raw.windowEnd ?? ""));
  if (windowStart >= windowEnd) throw new TypeError("Coverage window must have positive duration");
  return Object.freeze({
    sourceSystem,
    scope: nonempty(raw.scope, "coverage scope"),
    windowStart,
    windowEnd,
    status: raw.status as EventCoverageRef["status"],
    coverageId: nonempty(raw.coverageId, "coverageId"),
  });
}

function normalizeInput<TPayload extends Record<string, unknown>>(
  inputValue: EventEnvelopeV2Input<TPayload>,
): Omit<EventEnvelopeV2<TPayload>, "eventId" | "payloadSha256"> {
  const input = record(inputValue, "event envelope input");
  const sourceSystem = input.sourceSystem as EventSource;
  if (!["x", "tg", "blockchain"].includes(sourceSystem)) {
    throw new TypeError("Unsupported V2 sourceSystem");
  }
  const eventKind = nonempty(input.eventKind, "eventKind");
  const eventKey = nonempty(input.eventKey, "eventKey");
  const schemaVersion = nonempty(input.schemaVersion, "schemaVersion", 128);
  const producer = record(input.producer, "producer");
  const producerName = nonempty(producer.name, "producer.name", 128);
  const producerVersion = nonempty(producer.version, "producer.version", 128);
  const clocks = record(input.clocks, "clocks");
  if (clocks.occurredAt !== null && typeof clocks.occurredAt !== "string") {
    throw new TypeError("occurredAt must be an ISO timestamp or null");
  }
  if (typeof clocks.observedAt !== "string" || typeof clocks.emittedAt !== "string") {
    throw new TypeError("observedAt and emittedAt are required ISO timestamps");
  }
  const normalizedClocks = Object.freeze({
    occurredAt: clocks.occurredAt === null ? null : toUtcIso(clocks.occurredAt),
    observedAt: toUtcIso(clocks.observedAt),
    emittedAt: toUtcIso(clocks.emittedAt),
  });
  if (normalizedClocks.observedAt > normalizedClocks.emittedAt) {
    throw new TypeError("observedAt cannot be later than emittedAt");
  }

  const definition = getSchemaDefinition(sourceSystem, eventKind, schemaVersion);
  if (!definition) {
    throw new TypeError("Unsupported event schema: " + sourceSystem + ":" + eventKind + ":" + schemaVersion);
  }
  const entityRefs = normalizeEntityRefs(input.entityRefs, normalizedClocks.observedAt);
  const evidenceRefs = normalizeEvidenceRefs(input.evidenceRefs, sourceSystem);
  const coverageRef = input.coverageRef === undefined
    ? undefined
    : normalizeCoverageRef(input.coverageRef, sourceSystem);
  const payloadText = canonicalJsonStringify(input.payload);
  const payload = JSON.parse(payloadText) as TPayload;
  validateRegisteredPayload({
    sourceSystem, eventKind, eventKey, schemaVersion,
  }, payload);
  const payloadRecord = record(payload, "payload");
  const registryEvent = record(payloadRecord.registryEvent, "payload.registryEvent");
  if (!Array.isArray(registryEvent.entityRefs) || registryEvent.entityRefs.length !== entityRefs.length) {
    throw new TypeError("Envelope entityRefs do not match source registry evidence");
  }
  const sourceEntityRefs = registryEvent.entityRefs.map((value) => {
    const ref = record(value, "payload.registryEvent.entityRefs[]");
    return { kind: ref.kind, canonicalId: ref.canonicalId };
  });
  const sortRefs = (refs: Array<{ kind: unknown; canonicalId: unknown }>) =>
    refs.map((ref) => canonicalJsonStringify(ref)).sort();
  if (canonicalJsonStringify(sortRefs(sourceEntityRefs)) !==
      canonicalJsonStringify(sortRefs(entityRefs))) {
    throw new TypeError("Envelope entityRefs differ from source registry entityRefs");
  }
  const sourceEvidence = validateEvidenceRef(registryEvent.evidenceRef);
  if (evidenceRefs.length !== 1 ||
      canonicalJsonStringify(sourceEvidence) !== canonicalJsonStringify((({ contentSha256: _hash, ...rest }) => rest)(evidenceRefs[0]!)) ||
      normalizedClocks.observedAt !== sourceEvidence.observedAt ||
      normalizedClocks.occurredAt !== (sourceEvidence.occurredAt ?? null)) {
    throw new TypeError("Envelope evidenceRefs/clocks differ from source registry evidence");
  }

  return {
    envelopeVersion: "event-envelope-v2",
    sourceSystem,
    eventKind,
    eventKey,
    schemaVersion,
    producer: Object.freeze({ name: producerName, version: producerVersion }),
    clocks: normalizedClocks,
    entityRefs: Object.freeze(entityRefs),
    evidenceRefs: Object.freeze(evidenceRefs),
    ...(coverageRef === undefined ? {} : { coverageRef }),
    payload,
  };
}

export function buildEventEnvelopeV2<TPayload extends Record<string, unknown>>(
  input: EventEnvelopeV2Input<TPayload>,
): EventEnvelopeV2<TPayload> {
  const normalized = normalizeInput(input);
  const eventId = createEventId(normalized.sourceSystem, normalized.eventKind, normalized.eventKey);
  const base = { ...normalized, eventId };
  const payloadSha256 = sha256Canonical(base);
  return Object.freeze({ ...base, payloadSha256 });
}

export function validateEventEnvelopeV2(inputValue: unknown): EventEnvelopeV2 {
  const input = record(inputValue, "event envelope");
  validateJsonSchema(input, EVENT_ENVELOPE_V2_JSON_SCHEMA, "$");
  const allowed = new Set([
    "envelopeVersion", "eventId", "sourceSystem", "eventKind", "eventKey",
    "schemaVersion", "producer", "clocks", "entityRefs", "evidenceRefs",
    "coverageRef", "payload", "payloadSha256",
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new TypeError("Unknown envelope field: " + key);
  }
  if (input.envelopeVersion !== "event-envelope-v2") {
    throw new TypeError("Unsupported envelope version");
  }
  const built = buildEventEnvelopeV2({
    sourceSystem: input.sourceSystem as EventSource,
    eventKind: input.eventKind as string,
    eventKey: input.eventKey as string,
    schemaVersion: input.schemaVersion as string,
    producer: input.producer as EventEnvelopeV2Input["producer"],
    clocks: input.clocks as EventEnvelopeV2Input["clocks"],
    entityRefs: input.entityRefs as EventEntityRef[],
    evidenceRefs: input.evidenceRefs as EventEvidenceRef[],
    ...(input.coverageRef === undefined ? {} : { coverageRef: input.coverageRef as EventCoverageRef }),
    payload: input.payload as Record<string, unknown>,
  });
  if (input.eventId !== built.eventId) throw new TypeError("Event ID does not match canonical identity");
  if (input.payloadSha256 !== built.payloadSha256) throw new TypeError("Event payload SHA-256 mismatch");
  if (canonicalJsonStringify(input) !== canonicalJsonStringify(built)) {
    throw new TypeError("Event envelope is not in canonical normalized form");
  }
  return built;
}

export type EventReplayClassification = "different" | "duplicate" | "collision";

/** Same source/kind/key with a different canonical hash is a hard collision. */
export function classifyEventReplay(
  existing: EventEnvelopeV2,
  incoming: EventEnvelopeV2,
): EventReplayClassification {
  const sameIdentity = existing.sourceSystem === incoming.sourceSystem &&
    existing.eventKind === incoming.eventKind &&
    existing.eventKey === incoming.eventKey &&
    existing.eventId === incoming.eventId;
  if (!sameIdentity) return "different";
  return existing.payloadSha256 === incoming.payloadSha256 ? "duplicate" : "collision";
}

export function assertNoEventIdentityCollision(
  existing: EventEnvelopeV2,
  incoming: EventEnvelopeV2,
): "different" | "duplicate" {
  const classification = classifyEventReplay(existing, incoming);
  if (classification === "collision") {
    throw new TypeError("Event identity collision: same event identity has a different payload SHA-256");
  }
  return classification;
}
