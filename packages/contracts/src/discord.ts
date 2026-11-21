import { buildEntityRef } from "./entity-registry.js";
import { buildEvidenceRef } from "./evidence.js";
import { buildEventEnvelopeV2, type EventEnvelopeV2 } from "./event-envelope.js";
import { formatSourceId, isDiscordSnowflake } from "./canonical-ids.js";
import { buildTimelineEvent } from "./timeline.js";
import { toUtcIso } from "./time.js";

export type DiscordMessageKind = "observed" | "edited" | "deleted";
export type DiscordMessageEnvelopeInput = Readonly<{
  kind: DiscordMessageKind;
  channelId: string;
  messageId: string;
  revisionKey: string;
  observedAt: Date | string;
  emittedAt: Date | string;
  occurredAt?: Date | string | null;
  contentSha256?: string | null;
  contentErased?: boolean;
  deletionReason?: "deleted" | "retention_expired" | "channel_revoked" | "user_requested";
  producerVersion: string;
}>;

const SHA256 = /^[a-f0-9]{64}$/;

/** Privacy-minimized V2 builder. It never accepts raw message text, author IDs or guild IDs. */
export function buildDiscordMessageEnvelope(input: DiscordMessageEnvelopeInput): EventEnvelopeV2 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Discord envelope input must be an object");
  }
  const allowed = new Set([
    "kind", "channelId", "messageId", "revisionKey", "observedAt",
    "emittedAt", "occurredAt", "contentSha256", "contentErased", "deletionReason", "producerVersion",
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new TypeError("Unknown Discord envelope input field: " + key);
  }
  if (!["observed", "edited", "deleted"].includes(input.kind)) {
    throw new TypeError("Invalid Discord message kind");
  }
  if (!isDiscordSnowflake(input.channelId) || !isDiscordSnowflake(input.messageId)) {
    throw new TypeError("Invalid Discord Snowflake identity");
  }
  if (!SHA256.test(input.revisionKey)) throw new TypeError("Invalid Discord revision SHA-256");
  if (typeof input.producerVersion !== "string" || !input.producerVersion.trim() ||
      input.producerVersion.length > 128) {
    throw new TypeError("Invalid Discord producer version");
  }
  const deleted = input.kind === "deleted";
  if (deleted && input.contentSha256 != null) {
    throw new TypeError("Deleted Discord event cannot retain a content hash");
  }
  if (deleted && input.contentErased !== true) {
    throw new TypeError("Discord deletion requires confirmed content erasure");
  }
  if (deleted && input.deletionReason !== undefined &&
      !["deleted", "retention_expired", "channel_revoked", "user_requested"].includes(input.deletionReason)) {
    throw new TypeError("Invalid Discord deletion reason");
  }
  if (!deleted && input.deletionReason !== undefined) {
    throw new TypeError("Discord deletion reason is only valid for deletion events");
  }
  if (!deleted && input.contentErased === true) {
    throw new TypeError("Content erasure flag is only valid for deletion events");
  }
  if (!deleted && input.contentSha256 != null && !SHA256.test(input.contentSha256)) {
    throw new TypeError("Invalid Discord content SHA-256");
  }
  if (!deleted && (input.occurredAt == null || input.occurredAt === "")) {
    throw new TypeError("Observed/edited Discord events require a source occurrence time");
  }

  const eventKind = input.kind === "observed" ? "message_observed"
    : input.kind === "edited" ? "message_edited" : "message_deleted";
  const eventKey = ["discord:message", input.channelId, input.messageId, input.revisionKey].join(":");
  const sourceId = formatSourceId("discord", input.channelId);
  const entityRef = buildEntityRef({
    kind: "source", canonicalId: sourceId,
    firstSeenAt: input.observedAt, lastSeenAt: input.observedAt,
  });
  const evidenceRef = buildEvidenceRef({
    sourceKind: "discord_message",
    channelId: input.channelId,
    messageId: input.messageId,
    observedAt: input.observedAt,
    ...(input.occurredAt == null ? {} : { occurredAt: input.occurredAt }),
    provider: "discord",
    parserVersion: "discord-collector-v1",
  });
  const contentSha256 = input.contentSha256 ?? undefined;
  const payload: Record<string, unknown> = {
    registryEvent: {
      sourceSystem: "discord",
      eventKind,
      eventKey,
      schemaVersion: "discord-message-v1",
      entityRefs: [entityRef],
      evidenceRef,
    },
    ...(deleted ? {
      messageDeletion: { contentErased: input.contentErased === true, reason: input.deletionReason ?? "deleted" },
      timelineEvent: buildTimelineEvent({
        eventKey,
        kind: "discord_message_deleted",
        occurredAt: evidenceRef.observedAt,
        observedAt: evidenceRef.observedAt,
        entityRefs: [entityRef],
        evidenceRef,
        payload: { contentErased: true, reason: input.deletionReason ?? "deleted" },
      }),
    } : {
      timelineEvent: buildTimelineEvent({
        eventKey,
        kind: input.kind === "observed" ? "discord_message_published" : "discord_message_edited",
        occurredAt: evidenceRef.occurredAt!,
        observedAt: evidenceRef.observedAt,
        entityRefs: [entityRef],
        evidenceRef,
        payload: {
          contentAvailable: contentSha256 !== undefined,
          ...(contentSha256 === undefined ? {} : { contentSha256 }),
        },
      }),
    }),
  };

  return buildEventEnvelopeV2({
    sourceSystem: "discord",
    eventKind,
    eventKey,
    schemaVersion: "discord-message-v1",
    producer: { name: "discord-collector", version: input.producerVersion },
    clocks: {
      occurredAt: evidenceRef.occurredAt ?? null,
      observedAt: evidenceRef.observedAt,
      emittedAt: toUtcIso(input.emittedAt),
    },
    entityRefs: [{ kind: "source", canonicalId: sourceId }],
    evidenceRefs: [{
      ...evidenceRef,
      ...(contentSha256 === undefined ? {} : { contentSha256 }),
    }],
    payload,
  });
}
