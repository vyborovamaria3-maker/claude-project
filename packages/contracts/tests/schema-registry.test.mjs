import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  listSchemaDefinitions, getSchemaDefinition,
  checkSchemaCompatibility, assertSchemaCompatibility,
  assertSchemaDefinitionImmutable, canonicalJsonStringify,
  EVENT_ENVELOPE_V2_JSON_SCHEMA,
} from "../dist/index.js";

test("registry contains the existing X, TG and Solana V1 producer event kinds", () => {
  const definitions = listSchemaDefinitions();
  assert.equal(definitions.length, 10);
  assert.equal(new Set(definitions.map((item) => item.schemaId)).size, definitions.length);
  assert.ok(getSchemaDefinition("x", "tweet_observed", "x-tweet-v1"));
  assert.ok(getSchemaDefinition("tg", "message_observed", "tg-message-v1"));
  assert.ok(getSchemaDefinition("tg", "message_deleted", "tg-message-v1"));
  assert.ok(getSchemaDefinition("blockchain", "wallet_transaction_observed", "chain-raw-v1"));
  assert.ok(getSchemaDefinition("blockchain", "token_swap_evidence_observed", "chain-token-evidence-v1"));
  assert.ok(getSchemaDefinition("blockchain", "token_swap_evidence_revision", "chain-token-revision-v1"));
  assert.ok(getSchemaDefinition("x", "token_link_verified", "token-link-v1"));
  assert.ok(getSchemaDefinition("tg", "token_links_invalidated", "token-link-v1"));
  assert.equal(getSchemaDefinition("blockchain", "wallet_transaction_observed", "chain-raw-v2"), undefined);
  assert.equal(getSchemaDefinition("ethereum", "transaction_observed", "evm-v1"), undefined);
});

test("published Event Envelope JSON Schema matches the TypeScript registry schema", async () => {
  const raw = await readFile(new URL("../schemas/event-envelope-v2.schema.json", import.meta.url), "utf8");
  const document = JSON.parse(raw);
  assert.equal(canonicalJsonStringify(document), canonicalJsonStringify(EVENT_ENVELOPE_V2_JSON_SCHEMA));
});

test("backward compatibility permits optional additive fields but not new required fields", () => {
  const previous = {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  };
  const additive = {
    type: "object",
    properties: { id: { type: "string" }, label: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  };
  assert.equal(checkSchemaCompatibility(previous, additive, "backward").compatible, true);
  assert.equal(checkSchemaCompatibility(previous, additive, "forward").compatible, false);
  assert.throws(() => assertSchemaCompatibility(previous, additive, "full"), /Incompatible/);

  const newlyRequired = {
    ...additive,
    required: ["id", "label"],
  };
  assert.equal(checkSchemaCompatibility(previous, newlyRequired, "backward").compatible, false);
});

test("forward compatibility requires the new schema to preserve old required fields", () => {
  const previous = {
    type: "object",
    properties: { id: { type: "string" }, label: { type: "string" } },
    required: ["id", "label"],
    additionalProperties: false,
  };
  const next = {
    type: "object",
    properties: { id: { type: "string" }, label: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  };
  assert.equal(checkSchemaCompatibility(previous, next, "forward").compatible, false);
});

test("forward compatibility treats omitted additionalProperties as permissive", () => {
  const previous = {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  };
  const next = {
    type: "object",
    properties: { id: { type: "string" }, label: { type: "string" } },
    required: ["id"],
  };
  assert.equal(checkSchemaCompatibility(previous, next, "forward").compatible, true);
});

test("root validation constraints cannot change under a compatible schema version", () => {
  const previous = {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  };
  const next = {
    type: "array",
    items: { type: "string" },
  };
  assert.equal(checkSchemaCompatibility(previous, next, "backward").compatible, false);
  assert.equal(checkSchemaCompatibility(previous, next, "forward").compatible, false);
});

test("a published schema ID cannot be reused for changed wire semantics", () => {
  const definition = listSchemaDefinitions()[0];
  assert.ok(definition);
  assert.doesNotThrow(() => assertSchemaDefinitionImmutable(definition, definition));
  assert.throws(() => assertSchemaDefinitionImmutable(definition, {
    ...definition,
    jsonSchema: { ...definition.jsonSchema, title: "Changed under same ID" },
  }), /immutable/);
  assert.throws(() => assertSchemaDefinitionImmutable(definition, {
    ...definition,
    producerName: "tg-collector",
  }), /immutable/);
});
