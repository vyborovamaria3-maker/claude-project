import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEventEnvelopeV2, validateEventEnvelopeV2,
  classifyEventReplay, assertNoEventIdentityCollision,
  canonicalJsonStringify, sha256Canonical,
} from "../dist/index.js";

const observedAt = "2026-10-18T01:00:00.000Z";
const occurredAt = "2026-10-18T00:45:00.000Z";
const emittedAt = "2026-10-18T01:00:02.000Z";
const eventKey = "x:tweet:123:observed:" + Date.parse(observedAt);
const evidenceRef = {
  sourceKind: "x_tweet",
  sourceId: "x:tweet:123",
  observedAt,
  occurredAt,
  parserVersion: "x-collector-v1",
};
const entityRefs = [{
  kind: "author",
  canonicalId: "x:999",
  firstSeenAt: observedAt,
  lastSeenAt: observedAt,
}];
const payload = {
  registryEvent: {
    sourceSystem: "x", eventKind: "tweet_observed", eventKey,
    schemaVersion: "x-tweet-v1", entityRefs, evidenceRef,
  },
  timelineEvent: {
    schemaVersion: "timeline-v1", eventKey, kind: "tweet_published",
    occurredAt, observedAt, entityRefs, evidenceRef, payload: {},
  },
};

function build(version = "legacy-v1") {
  return buildEventEnvelopeV2({
    sourceSystem: "x",
    eventKind: "tweet_observed",
    eventKey,
    schemaVersion: "x-tweet-v1",
    producer: { name: "x-collector", version },
    clocks: { occurredAt, observedAt, emittedAt },
    entityRefs: [{ kind: "author", canonicalId: "x:999" }],
    evidenceRefs: [evidenceRef],
    payload,
  });
}

test("canonical JSON sorts object keys but preserves array order", () => {
  assert.equal(
    canonicalJsonStringify({ z: 1, a: { y: 2, x: 1 } }),
    '{"a":{"x":1,"y":2},"z":1}',
  );
  assert.equal(sha256Canonical({ a: 1, b: 2 }), sha256Canonical({ b: 2, a: 1 }));
  assert.notEqual(sha256Canonical([1, 2]), sha256Canonical([2, 1]));
});

test("canonical JSON rejects values JSON.stringify would silently lose or rewrite", () => {
  assert.throws(() => canonicalJsonStringify({ missing: undefined }), /Non-JSON value/);
  assert.throws(() => canonicalJsonStringify({ amount: Number.NaN }), /Non-finite/);
  assert.throws(() => canonicalJsonStringify(new Date()), /Non-plain object/);
  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => canonicalJsonStringify(cycle), /Circular/);
  const sparse = [];
  sparse.length = 2;
  assert.throws(() => canonicalJsonStringify(sparse), /Sparse/);
  const accessor = [];
  Object.defineProperty(accessor, "0", { enumerable: true, get() { return 1; } });
  accessor.length = 1;
  assert.throws(() => canonicalJsonStringify(accessor), /Accessor/);
  const hiddenExtra = [1];
  Object.defineProperty(hiddenExtra, "secret", { value: 2, enumerable: false });
  assert.throws(() => canonicalJsonStringify(hiddenExtra), /extended array/);
  const customPrototype = Object.setPrototypeOf([1], Object.create(Array.prototype));
  assert.throws(() => canonicalJsonStringify(customPrototype), /Non-plain array/);
});

test("V2 envelope builds and validates with stable identity and canonical hash", () => {
  const event = build();
  assert.match(event.eventId, /^evt_v2_[a-f0-9]{64}$/);
  assert.match(event.payloadSha256, /^[a-f0-9]{64}$/);
  assert.equal(event.envelopeVersion, "event-envelope-v2");
  assert.deepEqual(event.entityRefs, [{ kind: "author", canonicalId: "x:999" }]);
  assert.deepEqual(validateEventEnvelopeV2(JSON.parse(JSON.stringify(event))), event);
});

test("built payload is deeply immutable and unknown input fields fail closed", () => {
  const event = build();
  assert.equal(Object.isFrozen(event.payload), true);
  assert.equal(Object.isFrozen(event.payload.registryEvent), true);
  assert.equal(Object.isFrozen(event.payload.registryEvent.entityRefs), true);
  assert.throws(() => {
    event.payload.registryEvent.eventKind = "tampered";
  }, TypeError);

  assert.throws(() => buildEventEnvelopeV2({
    sourceSystem: "x", eventKind: "tweet_observed", eventKey,
    schemaVersion: "x-tweet-v1",
    producer: { name: "x-collector", version: "legacy-v1", build: "extra" },
    clocks: { occurredAt, observedAt, emittedAt },
    entityRefs: [{ kind: "author", canonicalId: "x:999" }],
    evidenceRefs: [evidenceRef], payload,
  }), /Unknown producer field/);

  assert.throws(() => buildEventEnvelopeV2({
    sourceSystem: "x", eventKind: "tweet_observed", eventKey,
    schemaVersion: "x-tweet-v1",
    producer: { name: "x-collector", version: "legacy-v1" },
    clocks: { occurredAt, observedAt, emittedAt, receivedAt: emittedAt },
    entityRefs: [{ kind: "author", canonicalId: "x:999" }],
    evidenceRefs: [evidenceRef], payload,
  }), /Unknown clocks field/);

  assert.throws(() => buildEventEnvelopeV2({
    sourceSystem: "x", eventKind: "tweet_observed", eventKey,
    schemaVersion: "x-tweet-v1", extra: true,
    producer: { name: "x-collector", version: "legacy-v1" },
    clocks: { occurredAt, observedAt, emittedAt },
    entityRefs: [{ kind: "author", canonicalId: "x:999" }],
    evidenceRefs: [evidenceRef], payload,
  }), /Unknown event envelope input field/);

  assert.throws(() => buildEventEnvelopeV2({
    sourceSystem: "x", eventKind: "tweet_observed", eventKey,
    schemaVersion: "x-tweet-v1",
    producer: { name: "x-collector", version: "legacy-v1" },
    clocks: { occurredAt, observedAt, emittedAt },
    entityRefs: [{ kind: "author", canonicalId: "x:999", firstSeenAt: observedAt }],
    evidenceRefs: [evidenceRef], payload,
  }), /Unknown entityRef field/);
});

test("source occurrence cannot be later than first observation", () => {
  assert.throws(() => buildEventEnvelopeV2({
    sourceSystem: "x", eventKind: "tweet_observed", eventKey,
    schemaVersion: "x-tweet-v1",
    producer: { name: "x-collector", version: "legacy-v1" },
    clocks: {
      occurredAt: "2026-10-18T01:01:00.000Z",
      observedAt,
      emittedAt,
    },
    entityRefs: [{ kind: "author", canonicalId: "x:999" }],
    evidenceRefs: [evidenceRef], payload,
  }), /occurredAt cannot be later than observedAt/);
});

test("same event identity with same hash is duplicate; different hash is collision", () => {
  const original = build();
  const replay = validateEventEnvelopeV2(JSON.parse(JSON.stringify(original)));
  assert.equal(classifyEventReplay(original, replay), "duplicate");
  assert.equal(assertNoEventIdentityCollision(original, replay), "duplicate");

  const changedProducer = build("different-build");
  assert.equal(changedProducer.eventId, original.eventId);
  assert.equal(changedProducer.payloadSha256 === original.payloadSha256, false);
  assert.equal(classifyEventReplay(original, changedProducer), "collision");
  assert.throws(() => assertNoEventIdentityCollision(original, changedProducer), /collision/);

  const differentKey = buildEventEnvelopeV2({
    sourceSystem: "x", eventKind: "tweet_observed",
    eventKey: eventKey + ":other", schemaVersion: "x-tweet-v1",
    producer: { name: "x-collector", version: "legacy-v1" },
    clocks: { occurredAt, observedAt, emittedAt },
    entityRefs: [{ kind: "author", canonicalId: "x:999" }],
    evidenceRefs: [evidenceRef],
    payload: {
      registryEvent: { ...payload.registryEvent, eventKey: eventKey + ":other" },
      timelineEvent: { ...payload.timelineEvent, eventKey: eventKey + ":other" },
    },
  });
  assert.equal(classifyEventReplay(original, differentKey), "different");
});

test("top-level entity/evidence refs and clocks must match the immutable source payload", () => {
  assert.throws(() => buildEventEnvelopeV2({
    sourceSystem: "x", eventKind: "tweet_observed", eventKey,
    schemaVersion: "x-tweet-v1",
    producer: { name: "x-collector", version: "legacy-v1" },
    clocks: { occurredAt, observedAt, emittedAt },
    entityRefs: [{ kind: "author", canonicalId: "x:1000" }],
    evidenceRefs: [evidenceRef],
    payload,
  }), /entityRefs differ/);

  assert.throws(() => buildEventEnvelopeV2({
    sourceSystem: "x", eventKind: "tweet_observed", eventKey,
    schemaVersion: "x-tweet-v1",
    producer: { name: "x-collector", version: "legacy-v1" },
    clocks: { occurredAt, observedAt, emittedAt },
    entityRefs: [{ kind: "author", canonicalId: "x:999" }],
    evidenceRefs: [{ ...evidenceRef, sourceId: "x:tweet:124" }],
    payload,
  }), /evidenceRefs\/clocks differ/);

  assert.throws(() => buildEventEnvelopeV2({
    sourceSystem: "x", eventKind: "tweet_observed", eventKey,
    schemaVersion: "x-tweet-v1",
    producer: { name: "x-collector", version: "legacy-v1" },
    clocks: { occurredAt: null, observedAt, emittedAt },
    entityRefs: [{ kind: "author", canonicalId: "x:999" }],
    evidenceRefs: [evidenceRef],
    payload,
  }), /evidenceRefs\/clocks differ/);
});

test("tampered hash, unsupported schema and clock inversion fail closed", () => {
  const event = build();
  assert.throws(() => validateEventEnvelopeV2({ ...event, payloadSha256: "0".repeat(64) }), /SHA-256 mismatch/);
  assert.throws(() => buildEventEnvelopeV2({
    sourceSystem: "x", eventKind: "tweet_observed", eventKey,
    schemaVersion: "x-tweet-v99",
    producer: { name: "x-collector", version: "legacy-v1" },
    clocks: { occurredAt, observedAt, emittedAt },
    entityRefs: [{ kind: "author", canonicalId: "x:999" }],
    evidenceRefs: [evidenceRef], payload,
  }), /Unsupported event schema/);
  assert.throws(() => buildEventEnvelopeV2({
    sourceSystem: "x", eventKind: "tweet_observed", eventKey,
    schemaVersion: "x-tweet-v1",
    producer: { name: "x-collector", version: "legacy-v1" },
    clocks: { occurredAt, observedAt, emittedAt: occurredAt },
    entityRefs: [{ kind: "author", canonicalId: "x:999" }],
    evidenceRefs: [evidenceRef], payload,
  }), /observedAt cannot be later than emittedAt/);
});

test("coverage metadata is source-scoped and has a positive time window", () => {
  const event = buildEventEnvelopeV2({
    sourceSystem: "x", eventKind: "tweet_observed", eventKey,
    schemaVersion: "x-tweet-v1",
    producer: { name: "x-collector", version: "legacy-v1" },
    clocks: { occurredAt, observedAt, emittedAt },
    entityRefs: [{ kind: "author", canonicalId: "x:999" }],
    evidenceRefs: [evidenceRef],
    coverageRef: {
      sourceSystem: "x", scope: "account:999",
      windowStart: "2026-10-18T00:00:00Z",
      windowEnd: "2026-10-18T02:00:00Z",
      status: "partial", coverageId: "coverage-x-001",
    },
    payload,
  });
  assert.equal(event.coverageRef.status, "partial");
  assert.throws(() => buildEventEnvelopeV2({
    sourceSystem: "x", eventKind: "tweet_observed", eventKey,
    schemaVersion: "x-tweet-v1",
    producer: { name: "x-collector", version: "legacy-v1" },
    clocks: { occurredAt, observedAt, emittedAt },
    entityRefs: [{ kind: "author", canonicalId: "x:999" }],
    evidenceRefs: [evidenceRef],
    coverageRef: {
      sourceSystem: "tg", scope: "account:999",
      windowStart: "2026-10-18T02:00:00Z",
      windowEnd: "2026-10-18T01:00:00Z",
      status: "complete", coverageId: "coverage-wrong-source",
    },
    payload,
  }), /Coverage source does not match/);
});


test("Discord V2 message envelope validates source identity, channel provenance and privacy-minimized payload", () => {
  const guildId = "12345678901234567";
  const channelId = "22345678901234567";
  const messageId = "32345678901234567";
  const occurredAt = "2026-11-18T18:00:00.000Z";
  const observedAt = "2026-11-18T18:00:02.000Z";
  const emittedAt = "2026-11-18T18:00:03.000Z";
  const eventKey = "discord:message:" + guildId + ":" + channelId + ":" + messageId + ":observed";
  const evidenceRef = {
    sourceKind: "discord_message",
    sourceId: "discord:message:" + guildId + ":" + channelId + ":" + messageId,
    observedAt, occurredAt, provider: "discord-gateway", parserVersion: "discord-collector-v1",
  };
  const entityRefs = [{
    kind: "source", canonicalId: "discord:channel:" + channelId,
    firstSeenAt: observedAt, lastSeenAt: observedAt,
  }];
  const payload = {
    registryEvent: {
      sourceSystem: "discord", eventKind: "discord_message_observed", eventKey,
      schemaVersion: "discord-message-v1", entityRefs, evidenceRef,
    },
    timelineEvent: {
      schemaVersion: "timeline-v1", eventKey, kind: "discord_message_observed",
      occurredAt, observedAt, entityRefs, evidenceRef, payload: {},
    },
    discordMessage: { guildId, channelId, messageId, revisionAt: occurredAt },
  };
  const event = buildEventEnvelopeV2({
    sourceSystem: "discord", eventKind: "discord_message_observed", eventKey,
    schemaVersion: "discord-message-v1",
    producer: { name: "discord-collector", version: "test-v1" },
    clocks: { occurredAt, observedAt, emittedAt },
    entityRefs: [{ kind: "source", canonicalId: "discord:channel:" + channelId }],
    evidenceRefs: [evidenceRef],
    coverageRef: {
      sourceSystem: "discord", scope: "guild:" + guildId + "/channel:" + channelId,
      windowStart: "2026-11-18T17:00:00Z", windowEnd: "2026-11-18T19:00:00Z",
      status: "partial", coverageId: "discord-fixture-coverage-1",
    },
    payload,
  });
  assert.equal(validateEventEnvelopeV2(JSON.parse(JSON.stringify(event))).sourceSystem, "discord");
  assert.equal(event.entityRefs[0].canonicalId, "discord:channel:" + channelId);
  assert.throws(() => buildEventEnvelopeV2({
    sourceSystem: "discord", eventKind: "discord_message_observed", eventKey,
    schemaVersion: "discord-message-v1",
    producer: { name: "discord-collector", version: "test-v1" },
    clocks: { occurredAt, observedAt, emittedAt },
    entityRefs: [{ kind: "source", canonicalId: "discord:channel:" + channelId }],
    evidenceRefs: [{ ...evidenceRef, contentSha256: "a".repeat(64) }],
    payload,
  }), /cannot carry raw content pointers or content hashes/);
  assert.throws(() => buildEventEnvelopeV2({
    sourceSystem: "discord", eventKind: "discord_message_observed", eventKey,
    schemaVersion: "discord-message-v1",
    producer: { name: "discord-collector", version: "test-v1" },
    clocks: { occurredAt, observedAt, emittedAt },
    entityRefs: [{ kind: "source", canonicalId: "discord:channel:" + channelId }],
    evidenceRefs: [{ ...evidenceRef, rawPointer: "private://message-body" }],
    payload: {
      ...payload,
      registryEvent: { ...payload.registryEvent, evidenceRef: { ...evidenceRef, rawPointer: "private://message-body" } },
      timelineEvent: { ...payload.timelineEvent, evidenceRef: { ...evidenceRef, rawPointer: "private://message-body" } },
    },
  }), /cannot carry raw content pointers or content hashes/);
  assert.throws(() => buildEventEnvelopeV2({
    sourceSystem: "discord", eventKind: "discord_message_observed", eventKey,
    schemaVersion: "discord-message-v1",
    producer: { name: "discord-collector", version: "test-v1" },
    clocks: { occurredAt, observedAt, emittedAt },
    entityRefs: [{ kind: "source", canonicalId: "discord:channel:" + channelId }],
    evidenceRefs: [evidenceRef],
    payload: { ...payload, discordMessage: { ...payload.discordMessage, content: "private raw message" } },
  }), /not an allowed field/);
  const wrongChannelEntity = [{
    kind: "source", canonicalId: "discord:channel:99999999999999999",
    firstSeenAt: observedAt, lastSeenAt: observedAt,
  }];
  const wrongChannelPayload = {
    ...payload,
    registryEvent: { ...payload.registryEvent, entityRefs: wrongChannelEntity },
    timelineEvent: { ...payload.timelineEvent, entityRefs: wrongChannelEntity },
  };
  assert.throws(() => buildEventEnvelopeV2({
    sourceSystem: "discord", eventKind: "discord_message_observed", eventKey,
    schemaVersion: "discord-message-v1",
    producer: { name: "discord-collector", version: "test-v1" },
    clocks: { occurredAt, observedAt, emittedAt },
    entityRefs: [{ kind: "source", canonicalId: "discord:channel:99999999999999999" }],
    evidenceRefs: [evidenceRef], payload: wrongChannelPayload,
  }), /channel source/);
});

test("Discord delete event is a tombstone and cannot carry text or a timeline body", () => {
  const guildId = "12345678901234567";
  const channelId = "22345678901234567";
  const messageId = "32345678901234567";
  const observedAt = "2026-11-18T18:01:00.000Z";
  const emittedAt = "2026-11-18T18:01:01.000Z";
  const eventKey = "discord:message:" + guildId + ":" + channelId + ":" + messageId + ":deleted";
  const evidenceRef = {
    sourceKind: "discord_message",
    sourceId: "discord:message:" + guildId + ":" + channelId + ":" + messageId,
    observedAt, provider: "discord-gateway", parserVersion: "discord-collector-v1",
  };
  const entityRefs = [{
    kind: "source", canonicalId: "discord:channel:" + channelId,
    firstSeenAt: observedAt, lastSeenAt: observedAt,
  }];
  const payload = {
    registryEvent: {
      sourceSystem: "discord", eventKind: "discord_message_deleted", eventKey,
      schemaVersion: "discord-message-v1", entityRefs, evidenceRef,
    },
    discordMessage: { guildId, channelId, messageId },
  };
  const event = buildEventEnvelopeV2({
    sourceSystem: "discord", eventKind: "discord_message_deleted", eventKey,
    schemaVersion: "discord-message-v1",
    producer: { name: "discord-collector", version: "test-v1" },
    clocks: { occurredAt: null, observedAt, emittedAt },
    entityRefs: [{ kind: "source", canonicalId: "discord:channel:" + channelId }],
    evidenceRefs: [evidenceRef], payload,
  });
  assert.equal(validateEventEnvelopeV2(JSON.parse(JSON.stringify(event))).eventKind, "discord_message_deleted");
});


test("Discord edits use the revision timestamp as occurredAt and a revision-specific event key", () => {
  const guildId = "12345678901234567";
  const channelId = "22345678901234567";
  const messageId = "32345678901234567";
  const revisionAt = "2026-11-18T18:00:01.000Z";
  const observedAt = "2026-11-18T18:00:02.000Z";
  const emittedAt = "2026-11-18T18:00:03.000Z";
  const sourceId = "discord:message:" + guildId + ":" + channelId + ":" + messageId;
  const eventKey = sourceId + ":edited:" + revisionAt;
  const evidenceRef = {
    sourceKind: "discord_message", sourceId, observedAt, occurredAt: revisionAt,
    provider: "discord-gateway", parserVersion: "discord-collector-v1",
  };
  const entityRefs = [{
    kind: "source", canonicalId: "discord:channel:" + channelId,
    firstSeenAt: observedAt, lastSeenAt: observedAt,
  }];
  const payload = {
    registryEvent: {
      sourceSystem: "discord", eventKind: "discord_message_edited", eventKey,
      schemaVersion: "discord-message-v1", entityRefs, evidenceRef,
    },
    timelineEvent: {
      schemaVersion: "timeline-v1", eventKey, kind: "discord_message_edited",
      occurredAt: revisionAt, observedAt, entityRefs, evidenceRef, payload: {},
    },
    discordMessage: { guildId, channelId, messageId, revisionAt },
  };
  const event = buildEventEnvelopeV2({
    sourceSystem: "discord", eventKind: "discord_message_edited", eventKey,
    schemaVersion: "discord-message-v1",
    producer: { name: "discord-collector", version: "test-v1" },
    clocks: { occurredAt: revisionAt, observedAt, emittedAt },
    entityRefs: [{ kind: "source", canonicalId: "discord:channel:" + channelId }],
    evidenceRefs: [evidenceRef], payload,
  });
  assert.equal(event.clocks.occurredAt, revisionAt);
  assert.equal(validateEventEnvelopeV2(JSON.parse(JSON.stringify(event))).eventKind, "discord_message_edited");

  const wrongKey = sourceId + ":edited";
  assert.throws(() => buildEventEnvelopeV2({
    sourceSystem: "discord", eventKind: "discord_message_edited", eventKey: wrongKey,
    schemaVersion: "discord-message-v1",
    producer: { name: "discord-collector", version: "test-v1" },
    clocks: { occurredAt: revisionAt, observedAt, emittedAt },
    entityRefs: [{ kind: "source", canonicalId: "discord:channel:" + channelId }],
    evidenceRefs: [evidenceRef],
    payload: {
      ...payload,
      registryEvent: { ...payload.registryEvent, eventKey: wrongKey },
      timelineEvent: { ...payload.timelineEvent, eventKey: wrongKey },
    },
  }), /event key must uniquely identify/);

  const staleOccurredAt = "2026-11-18T18:00:00.000Z";
  const staleEvidence = { ...evidenceRef, occurredAt: staleOccurredAt };
  assert.throws(() => buildEventEnvelopeV2({
    sourceSystem: "discord", eventKind: "discord_message_edited", eventKey,
    schemaVersion: "discord-message-v1",
    producer: { name: "discord-collector", version: "test-v1" },
    clocks: { occurredAt: staleOccurredAt, observedAt, emittedAt },
    entityRefs: [{ kind: "source", canonicalId: "discord:channel:" + channelId }],
    evidenceRefs: [staleEvidence],
    payload: {
      ...payload,
      registryEvent: { ...payload.registryEvent, evidenceRef: staleEvidence },
      timelineEvent: { ...payload.timelineEvent, evidenceRef: staleEvidence, occurredAt: staleOccurredAt },
    },
  }), /revision clock must equal source occurredAt/);
});
