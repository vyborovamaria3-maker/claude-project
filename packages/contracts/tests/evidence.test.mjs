import test from "node:test";
import assert from "node:assert/strict";
import { buildEvidenceRef } from "../dist/index.js";

const NOW = "2026-10-17T20:30:00Z";
const SIG = "1".repeat(64);
const HASH = "0x" + "A1".repeat(32);

test("X tweet evidence uses stable tweet ID and retains two independent clocks", () => {
  const ref = buildEvidenceRef({
    sourceKind: "x_tweet", tweetId: "92233720368547758080",
    occurredAt: "2026-10-17T20:00:00Z",
    observedAt: NOW, provider: "xactions", parserVersion: "v1", rawPointer: "sha256:abc",
  });
  assert.equal(ref.sourceId, "x:tweet:92233720368547758080");
  assert.equal(ref.observedAt, "2026-10-17T20:30:00.000Z");
  assert.equal(ref.occurredAt, "2026-10-17T20:00:00.000Z");
  assert.equal(ref.provider, "xactions");
});

test("Telegram evidence key includes BOTH source and message", () => {
  const a = buildEvidenceRef({sourceKind:"tg_message",sourceAccountId:"-10001",messageId:"42",observedAt:NOW});
  const b = buildEvidenceRef({sourceKind:"tg_message",sourceAccountId:"-10002",messageId:"42",observedAt:NOW});
  assert.equal(a.sourceId, "tg:message:-10001:42");
  assert.notEqual(a.sourceId, b.sourceId);
});

test("chain evidence uses chain-specific stable transaction identity", () => {
  const sol = buildEvidenceRef({sourceKind:"chain_tx",chain:"solana",transactionId:SIG,observedAt:NOW});
  const eth = buildEvidenceRef({sourceKind:"chain_tx",chain:"ethereum",transactionId:HASH,observedAt:NOW});
  assert.equal(sol.sourceId, "chain:tx:solana:" + SIG);
  assert.equal(eth.sourceId, "chain:tx:ethereum:" + HASH.toLowerCase());
  assert.throws(() => buildEvidenceRef({sourceKind:"chain_tx",chain:"solana",transactionId:"bad",observedAt:NOW}), /signature/);
});

test("malformed provenance or ambiguous clocks are rejected", () => {
  assert.throws(() => buildEvidenceRef({sourceKind:"tg_message",sourceAccountId:"@durov",messageId:"1",observedAt:NOW}), /Stable numeric/);
  assert.throws(() => buildEvidenceRef({sourceKind:"x_tweet",tweetId:"abc",observedAt:NOW}), /Tweet ID/);
  assert.throws(() => buildEvidenceRef({sourceKind:"x_tweet",tweetId:"12",observedAt:"2026-10-17T20:00:00"}), /timezone/);
  assert.throws(() => buildEvidenceRef({sourceKind:"x_tweet",tweetId:"12",observedAt:NOW,provider:" "}), /Invalid provider/);
});
