import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { buildXTweetOutboxEvent } from "../../x-collector/src/collector/persistence/intelligence-outbox.ts";
import {
  buildVerifiedXTweetTokenLinkOutboxEvent,
  buildXTokenLinksInvalidatedOutboxEvent,
} from "../../x-collector/src/collector/persistence/verified-token-links.ts";
import {
  buildTgOutboxEvent,
  buildTgDeletionOutboxEvent,
  buildVerifiedTgTokenLinkOutboxEvent,
  buildTgTokenLinksInvalidatedOutboxEvent,
} from "../../tg-collector/src/persistence/outbox.ts";
import { adaptLegacyOutboxEventToV2 } from "@claude-project/contracts";

const require = createRequire(import.meta.url);
const {
  buildWalletRawEvent,
} = require("../../solana-launcher/scripts/blockchain-intelligence-outbox.cjs");
const {
  buildTokenSwapEvidenceEvent,
} = require("../../solana-launcher/scripts/blockchain-token-swap-outbox.cjs");
const {
  buildTokenSwapRevisionEvent,
} = require("../../solana-launcher/scripts/blockchain-token-swap-revisions.cjs");

const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const wallet = "1".repeat(32);
const signature = "1".repeat(64);
const sourceRevisionSha256 = "a".repeat(64);
const occurredAt = "2026-10-18T00:45:00.000Z";
const observedAt = "2026-10-18T01:00:00.000Z";
const emittedAt = "2026-10-18T01:00:03.000Z";
const observedMs = Date.parse(observedAt);
const postedMs = Date.parse(occurredAt);
const postedSeconds = Math.floor(postedMs / 1000);
const observedDate = new Date(observedAt);
const postedDate = new Date(occurredAt);
const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const swapTransaction = {
  signature,
  slot: 250000000,
  timestamp: postedSeconds,
  type: "SWAP",
  feePayer: wallet,
  fee: 5000,
  events: {
    swap: {
      nativeInput: { account: wallet, amount: "1000000000" },
      tokenOutputs: [{
        userAccount: wallet,
        mint,
        rawTokenAmount: { tokenAmount: "1000000", decimals: 6 },
      }],
    },
  },
  accountData: [{
    account: wallet,
    nativeBalanceChange: -1000005000,
    tokenBalanceChanges: [{
      userAccount: wallet,
      mint,
      rawTokenAmount: { tokenAmount: "1000000", decimals: 6 },
    }],
  }],
};

const actualV1Events = [
  buildXTweetOutboxEvent({
    id: "1234567890123456789",
    authorId: "99999999999999",
    observedAt: observedMs,
    postedAt: postedMs,
  }, observedMs),
  buildVerifiedXTweetTokenLinkOutboxEvent({
    tweetId: "1234567890123456789",
    authorId: "99999999999999",
    text: "Public fixture mentions " + mint,
    mint,
    observedAt: observedDate,
    postedAt: postedDate,
    mintVerification: {
      tokenProgram,
      provider: "alchemy-solana-rpc",
      checkedAt: new Date("2026-10-18T00:59:00.000Z"),
    },
  }),
  buildXTokenLinksInvalidatedOutboxEvent({
    tweetId: "1234567890123456789",
    authorId: "99999999999999",
    reason: "edited",
    sourceRevisionSha256,
    observedAt: observedDate,
    postedAt: postedDate,
  }),
  buildTgOutboxEvent("-100123456789", {
    id: 42,
    date: postedSeconds,
    message: "Private Telegram fixture text must not be exported: " + mint,
    views: 10,
    forwards: 2,
    replies: { replies: 1 },
  }, observedDate),
  buildTgDeletionOutboxEvent(
    "-100123456789", 42, observedDate, "20261018010003000000",
  ),
  buildVerifiedTgTokenLinkOutboxEvent({
    peerId: "-100123456789",
    messageId: "42",
    text: "Public fixture mentions " + mint,
    mint,
    tokenProgram,
    provider: "alchemy-solana-rpc",
    sourceRevisionSha256,
    observedAt: observedDate,
    postedAt: postedDate,
  }),
  buildTgTokenLinksInvalidatedOutboxEvent({
    peerId: "-100123456789",
    messageId: 42,
    reason: "edited",
    sourceRevisionSha256,
    observedAt: observedDate,
    postedAt: postedDate,
  }),
  buildWalletRawEvent({
    kind: "wallet",
    address: wallet,
    signature,
    payloadHash: sourceRevisionSha256,
    observedAt: observedMs,
    blockTime: postedSeconds,
  }),
  buildTokenSwapEvidenceEvent({
    kind: "wallet",
    address: wallet,
    signature,
    payloadHash: sourceRevisionSha256,
    observedAt: observedMs,
    transaction: swapTransaction,
  }),
  buildTokenSwapRevisionEvent({
    kind: "wallet",
    address: wallet,
    signature,
    payloadHash: sourceRevisionSha256,
    rawRevision: 1,
    observedAt: observedMs,
    transaction: swapTransaction,
  }),
];

test("actual X, Telegram and Solana V1 builders validate through the shared V2 registry", () => {
  assert.equal(actualV1Events.length, 10);
  for (const [index, event] of actualV1Events.entries()) {
    assert.ok(event, "producer fixture " + index + " should be emitted");
    const normalized = adaptLegacyOutboxEventToV2(event, { emittedAt });
    assert.equal(normalized.envelopeVersion, "event-envelope-v2");
    assert.equal(normalized.sourceSystem, event.sourceSystem);
    assert.equal(normalized.eventKind, event.eventKind);
    assert.equal(normalized.eventKey, event.eventKey);
    assert.equal(normalized.schemaVersion, event.schemaVersion);
    assert.equal(normalized.clocks.observedAt, observedAt);
    assert.equal(normalized.clocks.emittedAt, emittedAt);
    assert.match(normalized.payloadSha256, /^[a-f0-9]{64}$/);
  }
});

test("source producer fixtures do not export raw social text or private transaction details", () => {
  const social = actualV1Events.slice(0, 7);
  for (const event of social) {
    assert.ok(event);
    assert.equal(JSON.stringify(event).includes("Private Telegram fixture text"), false);
    assert.equal(JSON.stringify(event).includes("Public fixture mentions"), false);
  }
  const chainSwap = actualV1Events[8];
  assert.ok(chainSwap);
  assert.equal(JSON.stringify(chainSwap).includes("nativeBalanceChange"), false);
  assert.equal(JSON.stringify(chainSwap).includes("amountTokens"), false);
  assert.equal(JSON.stringify(chainSwap).includes("tokenBalanceChanges"), false);
});

test("V1 adapter does not guess emittedAt or rewrite source identity", () => {
  const event = actualV1Events[0];
  assert.ok(event);
  assert.throws(() => adaptLegacyOutboxEventToV2(event, {}), /created_at is required/);
  const normalized = adaptLegacyOutboxEventToV2(event, { emittedAt });
  assert.equal(normalized.evidenceRefs[0].sourceId, "x:tweet:1234567890123456789");
  assert.equal(normalized.producer.version, "legacy-v1");
});
