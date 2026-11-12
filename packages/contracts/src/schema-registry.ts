import { canonicalJsonStringify } from "./canonical-json.js";
import { buildEntityRef, type EntityKind } from "./entity-registry.js";
import { validateEvidenceRef, type EvidenceRef, type EvidenceSourceKind } from "./evidence.js";
import { buildTimelineEvent, type JsonValue, type TimelineEventKind } from "./timeline.js";
import { parseTokenId, parseWalletId, isSolanaSignature } from "./canonical-ids.js";
import { validateVerifiedTokenLinkEvent } from "./token-link.js";
import { validateTokenLinksInvalidatedEvent } from "./token-link-invalidation.js";

export type EventSource = "x" | "tg" | "blockchain";
export type CompatibilityMode = "backward" | "forward" | "full";

export type JsonSchema = Readonly<{
  $schema?: string;
  $id?: string;
  title?: string;
  type?: string | readonly string[];
  const?: unknown;
  enum?: readonly unknown[];
  properties?: Readonly<Record<string, JsonSchema>>;
  required?: readonly string[];
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
}>;

export type SchemaDefinition = Readonly<{
  schemaId: string;
  sourceSystem: EventSource;
  eventKind: string;
  schemaVersion: string;
  producerName: "x-collector" | "tg-collector" | "solana-launcher";
  consumers: readonly ["node-intelligence"];
  compatibilityMode: CompatibilityMode;
  deprecatedAt: null;
  migrationOwner: "POTAPoff Intelligence";
  jsonSchema: JsonSchema;
}>;

export type SchemaIdentity = Readonly<{
  sourceSystem: EventSource;
  eventKind: string;
  eventKey: string;
  schemaVersion: string;
}>;

const NONEMPTY = { type: "string", minLength: 1, maxLength: 512 } as const;
const TIME = { type: "string", minLength: 20, maxLength: 40 } as const;
const HASH = { type: "string", pattern: "^[a-f0-9]{64}$" } as const;
const EMPTY_OBJECT = { type: "object", additionalProperties: false } as const;

const ENTITY_REF: JsonSchema = {
  type: "object",
  required: ["kind", "canonicalId", "firstSeenAt", "lastSeenAt"],
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["token", "wallet", "author", "source"] },
    canonicalId: NONEMPTY,
    firstSeenAt: TIME,
    lastSeenAt: TIME,
  },
};

function evidenceSchema(sourceKind: EvidenceSourceKind, sourceIdPattern: string): JsonSchema {
  return {
    type: "object",
    required: ["sourceKind", "sourceId", "observedAt"],
    additionalProperties: false,
    properties: {
      sourceKind: { const: sourceKind },
      sourceId: { type: "string", pattern: sourceIdPattern, maxLength: 512 },
      observedAt: TIME,
      occurredAt: TIME,
      provider: { type: "string", minLength: 1, maxLength: 4096 },
      parserVersion: { type: "string", minLength: 1, maxLength: 4096 },
      rawPointer: { type: "string", minLength: 1, maxLength: 4096 },
    },
  };
}

const X_EVIDENCE = evidenceSchema("x_tweet", "^x:tweet:[1-9][0-9]*$");
const TG_EVIDENCE = evidenceSchema("tg_message", "^tg:message:-?(?:[1-9][0-9]*):[1-9][0-9]*$");
const CHAIN_EVIDENCE = evidenceSchema("chain_tx", "^chain:tx:solana:[1-9A-HJ-NP-Za-km-z]+$");

function registryEventSchema(
  sourceSystem: EventSource,
  eventKind: string,
  schemaVersion: string,
  evidence: JsonSchema,
): JsonSchema {
  return {
    type: "object",
    required: ["sourceSystem", "eventKind", "eventKey", "schemaVersion", "entityRefs", "evidenceRef"],
    additionalProperties: false,
    properties: {
      sourceSystem: { const: sourceSystem },
      eventKind: { const: eventKind },
      eventKey: NONEMPTY,
      schemaVersion: { const: schemaVersion },
      entityRefs: {
        type: "array", minItems: 1, maxItems: 200, items: ENTITY_REF,
      },
      evidenceRef: evidence,
    },
  };
}

function timelineEventSchema(
  eventKind: TimelineEventKind,
  evidence: JsonSchema,
  payload: JsonSchema = EMPTY_OBJECT,
): JsonSchema {
  return {
    type: "object",
    required: ["schemaVersion", "eventKey", "kind", "occurredAt", "observedAt", "entityRefs", "evidenceRef", "payload"],
    additionalProperties: false,
    properties: {
      schemaVersion: { const: "timeline-v1" },
      eventKey: NONEMPTY,
      kind: { const: eventKind },
      occurredAt: TIME,
      observedAt: TIME,
      entityRefs: { type: "array", minItems: 1, maxItems: 200, items: ENTITY_REF },
      evidenceRef: evidence,
      payload,
    },
  };
}

function payloadSchema(
  registry: JsonSchema,
  extra: Readonly<Record<string, JsonSchema>> = {},
  requiredExtra: readonly string[] = [],
): JsonSchema {
  const properties: Record<string, JsonSchema> = { registryEvent: registry, ...extra };
  return {
    type: "object",
    required: ["registryEvent", ...requiredExtra],
    additionalProperties: false,
    properties,
  };
}

function define(
  sourceSystem: EventSource,
  eventKind: string,
  schemaVersion: string,
  producerName: SchemaDefinition["producerName"],
  jsonSchema: JsonSchema,
): SchemaDefinition {
  return Object.freeze({
    schemaId: "urn:potapoff:event:" + sourceSystem + ":" + eventKind + ":" + schemaVersion,
    sourceSystem,
    eventKind,
    schemaVersion,
    producerName,
    consumers: Object.freeze(["node-intelligence"] as const),
    compatibilityMode: "backward" as const,
    deprecatedAt: null,
    migrationOwner: "POTAPoff Intelligence" as const,
    jsonSchema: deepFreeze(jsonSchema),
  });
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

const X_REGISTRY = (kind: string, version: string) =>
  registryEventSchema("x", kind, version, X_EVIDENCE);
const TG_REGISTRY = (kind: string, version: string) =>
  registryEventSchema("tg", kind, version, TG_EVIDENCE);
const CHAIN_REGISTRY = (kind: string, version: string) =>
  registryEventSchema("blockchain", kind, version, CHAIN_EVIDENCE);

const TOKEN_LINK_SCHEMA: JsonSchema = {
  type: "object",
  required: ["status", "canonicalTokenId", "basis", "sourceRevisionSha256", "mintVerification"],
  additionalProperties: false,
  properties: {
    status: { const: "verified" },
    canonicalTokenId: { type: "string", pattern: "^solana:[1-9A-HJ-NP-Za-km-z]+$" },
    basis: { const: "literal_mint_address" },
    sourceRevisionSha256: HASH,
    mintVerification: {
      type: "object",
      required: ["chainId", "method", "tokenProgram", "provider", "checkedAt"],
      additionalProperties: false,
      properties: {
        chainId: { const: "solana-mainnet" },
        method: { const: "spl_mint_account" },
        tokenProgram: {
          type: "string",
          enum: [
            "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
          ],
        },
        provider: { type: "string", minLength: 1, maxLength: 64 },
        checkedAt: TIME,
      },
    },
  },
};

const INVALIDATION_SCHEMA: JsonSchema = {
  type: "object",
  required: ["status", "reason", "sourceRevisionSha256"],
  additionalProperties: false,
  properties: {
    status: { const: "invalidated" },
    reason: { type: "string", enum: ["edited", "deleted"] },
    sourceRevisionSha256: HASH,
  },
};

const SWAP_REVISION_SCHEMA: JsonSchema = {
  type: "object",
  required: ["walletId", "signature", "rawRevision", "rawSha256", "status", "canonicalTokenId", "slot"],
  additionalProperties: false,
  properties: {
    walletId: { type: "string", pattern: "^solana:[1-9A-HJ-NP-Za-km-z]+$" },
    signature: { type: "string", minLength: 64, maxLength: 88 },
    rawRevision: { type: "integer", minimum: 1 },
    rawSha256: HASH,
    status: { type: "string", enum: ["supported", "unsupported"] },
    canonicalTokenId: { type: ["string", "null"] },
    slot: { type: ["integer", "null"] },
  },
};

const SWAP_TIMELINE_PAYLOAD: JsonSchema = {
  type: "object",
  required: ["attribution", "evidenceStatus", "decoderVersion"],
  additionalProperties: false,
  properties: {
    attribution: { const: "provider_parsed_wallet_swap" },
    evidenceStatus: { const: "historical_raw_revision_only" },
    decoderVersion: NONEMPTY,
  },
};

const DEFINITIONS: readonly SchemaDefinition[] = Object.freeze([
  define("x", "tweet_observed", "x-tweet-v1", "x-collector",
    payloadSchema(X_REGISTRY("tweet_observed", "x-tweet-v1"), {
      timelineEvent: timelineEventSchema("tweet_published", X_EVIDENCE),
    }, ["timelineEvent"])),
  define("tg", "message_observed", "tg-message-v1", "tg-collector",
    payloadSchema(TG_REGISTRY("message_observed", "tg-message-v1"), {
      timelineEvent: timelineEventSchema("tg_message_published", TG_EVIDENCE),
    }, ["timelineEvent"])),
  define("tg", "message_deleted", "tg-message-v1", "tg-collector",
    payloadSchema(TG_REGISTRY("message_deleted", "tg-message-v1"))),
  define("blockchain", "wallet_transaction_observed", "chain-raw-v1", "solana-launcher",
    payloadSchema(CHAIN_REGISTRY("wallet_transaction_observed", "chain-raw-v1"), {
      timelineEvent: timelineEventSchema("chain_transaction", CHAIN_EVIDENCE),
    }, ["timelineEvent"])),
  define("blockchain", "token_swap_evidence_observed", "chain-token-evidence-v1", "solana-launcher",
    payloadSchema(CHAIN_REGISTRY("token_swap_evidence_observed", "chain-token-evidence-v1"), {
      timelineEvent: timelineEventSchema("chain_transaction", CHAIN_EVIDENCE, SWAP_TIMELINE_PAYLOAD),
    }, ["timelineEvent"])),
  define("blockchain", "token_swap_evidence_revision", "chain-token-revision-v1", "solana-launcher",
    payloadSchema(CHAIN_REGISTRY("token_swap_evidence_revision", "chain-token-revision-v1"), {
      swapRevision: SWAP_REVISION_SCHEMA,
    }, ["swapRevision"])),
  define("x", "token_link_verified", "token-link-v1", "x-collector",
    payloadSchema(X_REGISTRY("token_link_verified", "token-link-v1"), {
      tokenLink: TOKEN_LINK_SCHEMA,
    }, ["tokenLink"])),
  define("tg", "token_link_verified", "token-link-v1", "tg-collector",
    payloadSchema(TG_REGISTRY("token_link_verified", "token-link-v1"), {
      tokenLink: TOKEN_LINK_SCHEMA,
    }, ["tokenLink"])),
  define("x", "token_links_invalidated", "token-link-v1", "x-collector",
    payloadSchema(X_REGISTRY("token_links_invalidated", "token-link-v1"), {
      tokenLinksInvalidation: INVALIDATION_SCHEMA,
    }, ["tokenLinksInvalidation"])),
  define("tg", "token_links_invalidated", "token-link-v1", "tg-collector",
    payloadSchema(TG_REGISTRY("token_links_invalidated", "token-link-v1"), {
      tokenLinksInvalidation: INVALIDATION_SCHEMA,
    }, ["tokenLinksInvalidation"])),
]);

const INDEX = new Map(DEFINITIONS.map((definition) => [
  schemaKey(definition.sourceSystem, definition.eventKind, definition.schemaVersion),
  definition,
]));

export function schemaKey(sourceSystem: string, eventKind: string, schemaVersion: string): string {
  return sourceSystem + ":" + eventKind + ":" + schemaVersion;
}

export function listSchemaDefinitions(): readonly SchemaDefinition[] {
  return DEFINITIONS;
}

export function getSchemaDefinition(
  sourceSystem: string,
  eventKind: string,
  schemaVersion: string,
): SchemaDefinition | undefined {
  return INDEX.get(schemaKey(sourceSystem, eventKind, schemaVersion));
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Expected object at " + label);
  }
  return value as Record<string, unknown>;
}

function fail(path: string, message: string): never {
  throw new TypeError("Schema validation failed at " + path + ": " + message);
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object": return !!value && typeof value === "object" && !Array.isArray(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isSafeInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: return false;
  }
}

/** Small dependency-free validator for the JSON Schema keywords used by this registry. */
export function validateJsonSchema(value: unknown, schema: JsonSchema, path = "$"): void {
  if (schema.const !== undefined &&
      canonicalJsonStringify(value) !== canonicalJsonStringify(schema.const)) {
    fail(path, "does not match const");
  }
  if (schema.enum &&
      !schema.enum.some((item) => canonicalJsonStringify(value) === canonicalJsonStringify(item))) {
    fail(path, "is not an allowed enum value");
  }
  if (schema.type !== undefined) {
    const types: readonly string[] = typeof schema.type === "string"
      ? [schema.type]
      : schema.type as readonly string[];
    if (!types.some((type) => matchesType(value, type))) fail(path, "has the wrong type");
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) fail(path, "is too short");
    if (schema.maxLength !== undefined && value.length > schema.maxLength) fail(path, "is too long");
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) fail(path, "does not match pattern");
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "must be finite");
    if (schema.minimum !== undefined && value < schema.minimum) fail(path, "is below minimum");
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(path, "has too few items");
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(path, "has too many items");
    if (schema.items) value.forEach((item, index) => validateJsonSchema(item, schema.items!, path + "[" + index + "]"));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = record(value, path);
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(object, required)) fail(path, "is missing required field " + required);
    }
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(object)) {
      const childSchema = properties[key];
      if (childSchema) validateJsonSchema(child, childSchema, path + "." + key);
      else if (schema.additionalProperties === false) fail(path + "." + key, "is not an allowed field");
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        validateJsonSchema(child, schema.additionalProperties, path + "." + key);
      }
    }
  }
}

function compareEntityRefs(left: unknown[], right: unknown[]): boolean {
  const normalize = (items: unknown[]) => items
    .map((item) => canonicalJsonStringify(item))
    .sort();
  return canonicalJsonStringify(normalize(left)) === canonicalJsonStringify(normalize(right));
}

function validateLegacySemantics(identity: SchemaIdentity, payloadValue: unknown): void {
  const payload = record(payloadValue, "$.payload");
  const registry = record(payload.registryEvent, "$.payload.registryEvent");
  if (registry.sourceSystem !== identity.sourceSystem ||
      registry.eventKind !== identity.eventKind ||
      registry.eventKey !== identity.eventKey ||
      registry.schemaVersion !== identity.schemaVersion) {
    throw new TypeError("Outbox envelope and registry event identity differ");
  }
  if (!Array.isArray(registry.entityRefs)) throw new TypeError("Registry entityRefs must be an array");
  const entityRefs = registry.entityRefs.map((value) => {
    const ref = record(value, "$.payload.registryEvent.entityRefs[]");
    return buildEntityRef({
      kind: ref.kind as EntityKind,
      canonicalId: String(ref.canonicalId ?? ""),
      firstSeenAt: String(ref.firstSeenAt ?? ""),
      lastSeenAt: String(ref.lastSeenAt ?? ""),
    });
  });
  const evidenceRef = validateEvidenceRef(registry.evidenceRef);
  const evidenceForSource = {
    x: "x_tweet",
    tg: "tg_message",
    blockchain: "chain_tx",
  } as const;
  if (evidenceRef.sourceKind !== evidenceForSource[identity.sourceSystem]) {
    throw new TypeError("Evidence kind does not match sourceSystem");
  }

  // Bind the generic entity references to each source's canonical identity
  // shape. JSON Schema can constrain the fields, but not these cross-field
  // invariants.
  if (identity.eventKind === "tweet_observed") {
    if (entityRefs.length !== 1 || entityRefs[0]!.kind !== "author") {
      throw new TypeError("X tweet observation requires exactly one author entity");
    }
  } else if (identity.eventKind === "message_observed" ||
             identity.eventKind === "message_deleted") {
    const match = /^tg:message:(-?(?:[1-9][0-9]*)):([1-9][0-9]*)$/.exec(evidenceRef.sourceId);
    if (!match || entityRefs.length !== 1 || entityRefs[0]!.kind !== "source" ||
        entityRefs[0]!.canonicalId !== "tg:source:" + match[1]) {
      throw new TypeError("Telegram event source entity does not match message evidence");
    }
  } else if (identity.eventKind === "wallet_transaction_observed") {
    if (entityRefs.length !== 1 || entityRefs[0]!.kind !== "wallet") {
      throw new TypeError("Solana wallet observation requires exactly one wallet entity");
    }
  } else if (identity.eventKind === "token_swap_evidence_observed") {
    if (entityRefs.length !== 2 ||
        entityRefs.filter((ref) => ref.kind === "wallet").length !== 1 ||
        entityRefs.filter((ref) => ref.kind === "token").length !== 1) {
      throw new TypeError("Solana swap evidence requires one wallet and one token entity");
    }
  }

  if (payload.timelineEvent !== undefined) {
    const timelineRaw = record(payload.timelineEvent, "$.payload.timelineEvent");
    if (timelineRaw.schemaVersion !== "timeline-v1") {
      throw new TypeError("Unsupported timeline schema version");
    }
    const timelineEvidence = validateEvidenceRef(timelineRaw.evidenceRef);
    const timelineEntitiesRaw = timelineRaw.entityRefs;
    if (!Array.isArray(timelineEntitiesRaw)) throw new TypeError("Timeline entityRefs must be an array");
    const timelineEntities = timelineEntitiesRaw.map((value) => {
      const ref = record(value, "$.payload.timelineEvent.entityRefs[]");
      return buildEntityRef({
        kind: ref.kind as EntityKind,
        canonicalId: String(ref.canonicalId ?? ""),
        firstSeenAt: String(ref.firstSeenAt ?? ""),
        lastSeenAt: String(ref.lastSeenAt ?? ""),
      });
    });
    if (timelineRaw.eventKey !== identity.eventKey ||
        timelineRaw.observedAt !== evidenceRef.observedAt ||
        timelineEvidence.observedAt !== evidenceRef.observedAt ||
        timelineRaw.occurredAt !== (evidenceRef.occurredAt ?? evidenceRef.observedAt) ||
        canonicalJsonStringify(timelineEvidence) !== canonicalJsonStringify(evidenceRef) ||
        !compareEntityRefs(entityRefs, timelineEntities)) {
      throw new TypeError("Registry and timeline provenance disagree");
    }
    buildTimelineEvent({
      eventKey: String(timelineRaw.eventKey),
      kind: timelineRaw.kind as TimelineEventKind,
      occurredAt: String(timelineRaw.occurredAt),
      observedAt: String(timelineRaw.observedAt),
      entityRefs: timelineEntities,
      evidenceRef: timelineEvidence,
      payload: timelineRaw.payload as Record<string, JsonValue>,
    });
  }

  if (identity.eventKind === "token_link_verified") {
    validateVerifiedTokenLinkEvent({
      sourceSystem: identity.sourceSystem,
      eventKind: identity.eventKind,
      eventKey: identity.eventKey,
      schemaVersion: identity.schemaVersion,
      payload,
    });
  } else if (identity.eventKind === "token_links_invalidated") {
    validateTokenLinksInvalidatedEvent({
      sourceSystem: identity.sourceSystem,
      eventKind: identity.eventKind,
      eventKey: identity.eventKey,
      schemaVersion: identity.schemaVersion,
      payload,
    });
  } else if (identity.eventKind === "token_swap_evidence_revision") {
    const revision = record(payload.swapRevision, "$.payload.swapRevision");
    const walletId = parseWalletId(revision.walletId);
    if (!walletId || walletId.id !== revision.walletId ||
        entityRefs.length !== 1 || entityRefs[0]!.kind !== "wallet" ||
        entityRefs[0]!.canonicalId !== revision.walletId ||
        !isSolanaSignature(revision.signature) ||
        evidenceRef.sourceId !== "chain:tx:solana:" + revision.signature ||
        typeof revision.rawRevision !== "number" || !Number.isSafeInteger(revision.rawRevision) ||
        revision.rawRevision < 1 || typeof revision.rawSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(revision.rawSha256)) {
      throw new TypeError("Invalid Solana swap revision identity");
    }
    if (revision.status === "supported") {
      const token = parseTokenId(revision.canonicalTokenId);
      if (!token || token.id !== revision.canonicalTokenId ||
          typeof revision.slot !== "number" || !Number.isSafeInteger(revision.slot) ||
          revision.slot <= 0 || evidenceRef.occurredAt === undefined) {
        throw new TypeError("Supported swap revision requires canonical token and slot");
      }
    } else if (revision.status === "unsupported") {
      if (revision.canonicalTokenId !== null || revision.slot !== null) {
        throw new TypeError("Unsupported swap revision cannot claim token or slot");
      }
    } else {
      throw new TypeError("Invalid swap revision status");
    }
  }
}

/** Validate a source-owned V1 payload against the central immutable registry. */
export function validateRegisteredPayload(identity: SchemaIdentity, payload: unknown): SchemaDefinition {
  canonicalJsonStringify(payload);
  const definition = getSchemaDefinition(identity.sourceSystem, identity.eventKind, identity.schemaVersion);
  if (!definition) {
    throw new TypeError("Unsupported event schema: " +
      schemaKey(identity.sourceSystem, identity.eventKind, identity.schemaVersion));
  }
  if (typeof identity.eventKey !== "string" || !identity.eventKey.trim() || identity.eventKey.length > 512) {
    throw new TypeError("Invalid eventKey");
  }
  validateJsonSchema(payload, definition.jsonSchema, "$.payload");
  validateLegacySemantics(identity, payload);
  return definition;
}

function schemaShape(schema: JsonSchema): string {
  return canonicalJsonStringify({
    type: schema.type ?? null,
    const: schema.const ?? null,
    enum: schema.enum ?? null,
    pattern: schema.pattern ?? null,
    minimum: schema.minimum ?? null,
    minLength: schema.minLength ?? null,
    maxLength: schema.maxLength ?? null,
    minItems: schema.minItems ?? null,
    maxItems: schema.maxItems ?? null,
    items: schema.items ?? null,
    properties: schema.properties ?? {},
    required: [...(schema.required ?? [])].sort(),
    additionalProperties: schema.additionalProperties ?? true,
  });
}

export function checkSchemaCompatibility(
  previous: JsonSchema,
  next: JsonSchema,
  mode: CompatibilityMode,
): Readonly<{ compatible: boolean; issues: readonly string[] }> {
  const issues: string[] = [];
  const oldProperties = previous.properties ?? {};
  const newProperties = next.properties ?? {};
  const oldRequired = new Set(previous.required ?? []);
  const newRequired = new Set(next.required ?? []);
  const rootConstraints = (schema: JsonSchema) => canonicalJsonStringify({
    type: schema.type ?? null,
    const: schema.const ?? null,
    enum: schema.enum ?? null,
    pattern: schema.pattern ?? null,
    minimum: schema.minimum ?? null,
    minLength: schema.minLength ?? null,
    maxLength: schema.maxLength ?? null,
    minItems: schema.minItems ?? null,
    maxItems: schema.maxItems ?? null,
    items: schema.items ?? null,
  });
  if (rootConstraints(previous) !== rootConstraints(next)) {
    issues.push("schema: changed root validation constraints");
  }

  const checkBackward = () => {
    for (const key of Object.keys(oldProperties)) {
      if (!newProperties[key]) issues.push("backward: removed property " + key);
      else if (schemaShape(oldProperties[key]!) !== schemaShape(newProperties[key]!)) {
        issues.push("backward: changed property contract " + key);
      }
    }
    for (const key of newRequired) {
      if (!oldRequired.has(key)) issues.push("backward: newly required property " + key);
    }
    const oldAdditional = previous.additionalProperties ?? true;
    const newAdditional = next.additionalProperties ?? true;
    if ((oldAdditional === true && newAdditional !== true) ||
        (typeof oldAdditional === "object" &&
          (newAdditional === false ||
           (typeof newAdditional === "object" &&
            schemaShape(oldAdditional) !== schemaShape(newAdditional))))) {
      issues.push("backward: additional properties are more restricted");
    }
  };

  const checkForward = () => {
    for (const key of Object.keys(newProperties)) {
      if (!oldProperties[key]) {
        const additional = previous.additionalProperties;
        const accepted = additional === undefined || additional === true ||
          (typeof additional === "object" && schemaShape(additional) === schemaShape(newProperties[key]!));
        if (!accepted) {
          issues.push("forward: new property is not accepted by previous schema: " + key);
        }
      } else if (schemaShape(oldProperties[key]!) !== schemaShape(newProperties[key]!)) {
        issues.push("forward: changed property contract " + key);
      }
    }
    for (const key of oldRequired) {
      if (!newRequired.has(key)) issues.push("forward: previously required property may be omitted: " + key);
    }
    const oldAdditional = previous.additionalProperties ?? true;
    const newAdditional = next.additionalProperties ?? true;
    if ((oldAdditional === false && newAdditional !== false) ||
        (typeof oldAdditional === "object" &&
          (newAdditional === true ||
           (typeof newAdditional === "object" &&
            schemaShape(oldAdditional) !== schemaShape(newAdditional))))) {
      issues.push("forward: new schema permits additional fields rejected by previous schema");
    }
  };

  if (mode === "backward" || mode === "full") checkBackward();
  if (mode === "forward" || mode === "full") checkForward();
  return Object.freeze({ compatible: issues.length === 0, issues: Object.freeze(issues) });
}

export function assertSchemaCompatibility(
  previous: JsonSchema,
  next: JsonSchema,
  mode: CompatibilityMode,
): void {
  const result = checkSchemaCompatibility(previous, next, mode);
  if (!result.compatible) throw new TypeError("Incompatible schema change: " + result.issues.join("; "));
}

/** Reusing a schema ID for changed wire semantics is forbidden. */
export function assertSchemaDefinitionImmutable(previous: SchemaDefinition, next: SchemaDefinition): void {
  if (previous.schemaId !== next.schemaId) return;
  if (canonicalJsonStringify(previous) !== canonicalJsonStringify(next)) {
    throw new TypeError("Published schema definition is immutable: " + previous.schemaId);
  }
}
