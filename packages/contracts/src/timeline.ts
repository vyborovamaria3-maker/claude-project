import type { EntityRef } from "./entity-registry.js";
import type { EvidenceRef } from "./evidence.js";
import { toUtcIso } from "./time.js";

export const TIMELINE_EVENT_KINDS = [
  "tweet_published", "tg_message_published", "chain_transaction",
  "trade_executed", "signal_detected", "signal_outcome",
] as const;

export type TimelineEventKind = (typeof TIMELINE_EVENT_KINDS)[number];
export type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };

export type TimelineEvent = {
  schemaVersion: "timeline-v1";
  eventKey: string;
  kind: TimelineEventKind;
  occurredAt: string;
  observedAt: string;
  entityRefs: EntityRef[];
  evidenceRef: EvidenceRef;
  payload: { [key: string]: JsonValue };
};

function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    return false;
  }
  seen.add(value);
  const entries: unknown[] = Array.isArray(value) ? value : Object.values(value);
  const valid = entries.every((entry) => isJsonValue(entry, seen));
  seen.delete(value);
  return valid;
}

export function buildTimelineEvent(input: {
  eventKey: string;
  kind: TimelineEventKind;
  occurredAt: Date | string;
  observedAt: Date | string;
  entityRefs: EntityRef[];
  evidenceRef: EvidenceRef;
  payload?: Record<string, JsonValue>;
}): TimelineEvent {
  if (typeof input.eventKey !== "string" || !input.eventKey.trim() || input.eventKey.length > 512) {
    throw new TypeError("eventKey is required and must be stable");
  }
  if (!(TIMELINE_EVENT_KINDS as readonly string[]).includes(input.kind)) {
    throw new TypeError("Unsupported timeline event kind");
  }
  if (!Array.isArray(input.entityRefs) || input.entityRefs.length === 0) {
    throw new TypeError("Timeline event requires entity provenance");
  }
  if (!input.evidenceRef?.sourceId || !input.evidenceRef?.sourceKind) {
    throw new TypeError("Timeline event requires evidence");
  }
  const payload = input.payload ?? {};
  if (!isJsonValue(payload) || Array.isArray(payload)) throw new TypeError("Payload must be JSON-safe");
  return {
    schemaVersion: "timeline-v1",
    eventKey: input.eventKey,
    kind: input.kind,
    occurredAt: toUtcIso(input.occurredAt),
    observedAt: toUtcIso(input.observedAt),
    entityRefs: [...input.entityRefs],
    evidenceRef: input.evidenceRef,
    payload,
  };
}
