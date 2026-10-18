import test from "node:test";
import assert from "node:assert/strict";
import { buildEntityRef, formatTokenId, formatAuthorId, formatSourceId } from "../dist/index.js";

const date1 = "2026-10-16T14:00:00+02:00";
const date2 = "2026-10-16T15:00:00+02:00";
const SOL = "So11111111111111111111111111111111111111112";
const EVM = "0x" + "ab".repeat(20);

test("entity registry validates exact canonical identity and UTC times", () => {
  const token = buildEntityRef({
    kind: "token", canonicalId: formatTokenId("solana", SOL),
    firstSeenAt: date1, lastSeenAt: date2,
  });
  assert.equal(token.canonicalId, "solana:" + SOL);
  assert.equal(token.firstSeenAt, "2026-10-16T12:00:00.000Z");
  assert.equal(token.lastSeenAt, "2026-10-16T13:00:00.000Z");
  assert.equal(buildEntityRef({kind:"wallet", canonicalId:"ethereum:"+EVM, firstSeenAt:date1, lastSeenAt:date2}).kind, "wallet");
  assert.equal(buildEntityRef({kind:"author", canonicalId:formatAuthorId("x","10001"), firstSeenAt:date1, lastSeenAt:date2}).kind, "author");
  assert.equal(buildEntityRef({kind:"source", canonicalId:formatSourceId("tg","-1001234"), firstSeenAt:date1, lastSeenAt:date2}).kind, "source");
});

test("invalid entity key, mutable handles and backward timestamps are rejected", () => {
  assert.throws(() => buildEntityRef({kind:"token",canonicalId:"ethereum:"+EVM.toUpperCase(),firstSeenAt:date1,lastSeenAt:date2}), /Noncanonical/);
  assert.throws(() => buildEntityRef({kind:"source",canonicalId:"x:alice",firstSeenAt:date1,lastSeenAt:date2}), /Noncanonical/);
  assert.throws(() => buildEntityRef({kind:"author",canonicalId:"x:1",firstSeenAt:date2,lastSeenAt:date1}), /firstSeenAt/);
});
