import test from "node:test";
import assert from "node:assert/strict";
import {
  adaptLegacyOutboxEventToV2,
  buildEntityRef, buildEvidenceRef,
  buildVerifiedTokenLinkEvent, buildTokenLinksInvalidatedEvent,
} from "../dist/index.js";

const observedAt = "2026-10-18T01:00:00.000Z";
const occurredAt = "2026-10-18T00:45:00.000Z";
const emittedAt = "2026-10-18T01:00:03.000Z";
const signature = "1".repeat(64);
const wallet = "1".repeat(32);
const mint = "So11111111111111111111111111111111111111112";
const hash = "a".repeat(64);

function entity(kind, canonicalId) {
  return buildEntityRef({ kind, canonicalId, firstSeenAt: observedAt, lastSeenAt: observedAt });
}

function xTweet() {
  const eventKey = "x:tweet:123:observed:" + Date.parse(observedAt);
  const evidenceRef = buildEvidenceRef({
    sourceKind: "x_tweet", tweetId: "123", observedAt, occurredAt,
    parserVersion: "x-collector-v1",
  });
  const entityRefs = [entity("author", "x:999")];
  return {
    sourceSystem: "x", eventKind: "tweet_observed", eventKey,
    schemaVersion: "x-tweet-v1",
    payload: {
      registryEvent: { sourceSystem: "x", eventKind: "tweet_observed", eventKey,
        schemaVersion: "x-tweet-v1", entityRefs, evidenceRef },
      timelineEvent: { schemaVersion: "timeline-v1", eventKey, kind: "tweet_published",
        occurredAt, observedAt, entityRefs, evidenceRef, payload: {} },
    },
  };
}

function tgDeleted() {
  const eventKey = "tg:123456789:42:deleted:rev:" + hash;
  const evidenceRef = buildEvidenceRef({
    sourceKind: "tg_message", sourceAccountId: "-100123456789",
    messageId: "42", observedAt, parserVersion: "tg-mtproto-v1",
  });
  const entityRefs = [entity("source", "tg:source:-100123456789")];
  return {
    sourceSystem: "tg", eventKind: "message_deleted", eventKey,
    schemaVersion: "tg-message-v1",
    payload: {
      registryEvent: { sourceSystem: "tg", eventKind: "message_deleted", eventKey,
        schemaVersion: "tg-message-v1", entityRefs, evidenceRef },
    },
  };
}

function chainRaw() {
  const eventKey = "chain:wallet:" + wallet + ":signature:" + signature + ":hash:" + hash;
  const evidenceRef = buildEvidenceRef({
    sourceKind: "chain_tx", chain: "solana", transactionId: signature,
    observedAt, occurredAt, parserVersion: "chain-seed-v1",
  });
  const entityRefs = [entity("wallet", "solana:" + wallet)];
  return {
    sourceSystem: "blockchain", eventKind: "wallet_transaction_observed", eventKey,
    schemaVersion: "chain-raw-v1",
    payload: {
      registryEvent: { sourceSystem: "blockchain", eventKind: "wallet_transaction_observed",
        eventKey, schemaVersion: "chain-raw-v1", entityRefs, evidenceRef },
      timelineEvent: { schemaVersion: "timeline-v1", eventKey, kind: "chain_transaction",
        occurredAt, observedAt, entityRefs, evidenceRef, payload: {} },
    },
  };
}

function chainSwap() {
  const eventKey = "chain:wallet:" + wallet + ":signature:" + signature + ":swap";
  const evidenceRef = buildEvidenceRef({
    sourceKind: "chain_tx", chain: "solana", transactionId: signature,
    observedAt, occurredAt, parserVersion: "chain-swap-evidence-5",
  });
  const entityRefs = [entity("wallet", "solana:" + wallet), entity("token", "solana:" + mint)];
  return {
    sourceSystem: "blockchain", eventKind: "token_swap_evidence_observed", eventKey,
    schemaVersion: "chain-token-evidence-v1",
    payload: {
      registryEvent: { sourceSystem: "blockchain", eventKind: "token_swap_evidence_observed",
        eventKey, schemaVersion: "chain-token-evidence-v1", entityRefs, evidenceRef },
      timelineEvent: { schemaVersion: "timeline-v1", eventKey, kind: "chain_transaction",
        occurredAt, observedAt, entityRefs, evidenceRef,
        payload: { attribution: "provider_parsed_wallet_swap",
          evidenceStatus: "historical_raw_revision_only", decoderVersion: "5" } },
    },
  };
}

function chainRevision() {
  const eventKey = "chain:wallet:" + wallet + ":signature:" + signature + ":raw-revision:1";
  const evidenceRef = buildEvidenceRef({
    sourceKind: "chain_tx", chain: "solana", transactionId: signature,
    observedAt, parserVersion: "chain-swap-revision-1",
  });
  const entityRefs = [entity("wallet", "solana:" + wallet)];
  return {
    sourceSystem: "blockchain", eventKind: "token_swap_evidence_revision", eventKey,
    schemaVersion: "chain-token-revision-v1",
    payload: {
      registryEvent: { sourceSystem: "blockchain", eventKind: "token_swap_evidence_revision",
        eventKey, schemaVersion: "chain-token-revision-v1", entityRefs, evidenceRef },
      swapRevision: {
        walletId: "solana:" + wallet, signature, rawRevision: 1, rawSha256: hash,
        status: "unsupported", canonicalTokenId: null, slot: null,
      },
    },
  };
}

function tokenLink(sourceSystem) {
  const sourceEntity = sourceSystem === "x"
    ? entity("author", "x:999")
    : entity("source", "tg:source:-100123456789");
  const evidenceRef = sourceSystem === "x"
    ? buildEvidenceRef({ sourceKind: "x_tweet", tweetId: "123", observedAt, occurredAt })
    : buildEvidenceRef({ sourceKind: "tg_message", sourceAccountId: "-100123456789",
        messageId: "42", observedAt, occurredAt });
  return buildVerifiedTokenLinkEvent({
    sourceSystem, sourceEntity, evidenceRef, mint, matchedLiteralMint: mint,
    sourceRevisionSha256: hash,
    mintVerification: {
      chainId: "solana-mainnet", method: "spl_mint_account",
      tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      provider: "alchemy-solana-rpc", checkedAt: observedAt,
    },
  });
}

function invalidation(sourceSystem) {
  const sourceEntity = sourceSystem === "x"
    ? entity("author", "x:999")
    : entity("source", "tg:source:-100123456789");
  const evidenceRef = sourceSystem === "x"
    ? buildEvidenceRef({ sourceKind: "x_tweet", tweetId: "123", observedAt, occurredAt })
    : buildEvidenceRef({ sourceKind: "tg_message", sourceAccountId: "-100123456789",
        messageId: "42", observedAt, occurredAt });
  return buildTokenLinksInvalidatedEvent({
    sourceSystem, sourceEntity, evidenceRef, reason: "edited",
    sourceRevisionSha256: hash,
  });
}

function adapt(event) {
  return adaptLegacyOutboxEventToV2(event, { emittedAt });
}

test("X, Telegram and Solana V1 source events normalize without changing identity", () => {
  const cases = [
    xTweet(), tgDeleted(), chainRaw(), chainSwap(), chainRevision(),
    tokenLink("x"), tokenLink("tg"), invalidation("x"), invalidation("tg"),
  ];
  const normalized = cases.map(adapt);
  assert.equal(normalized.length, cases.length);
  for (let index = 0; index < cases.length; index++) {
    assert.equal(normalized[index].sourceSystem, cases[index].sourceSystem);
    assert.equal(normalized[index].eventKind, cases[index].eventKind);
    assert.equal(normalized[index].eventKey, cases[index].eventKey);
    assert.equal(normalized[index].schemaVersion, cases[index].schemaVersion);
    assert.match(normalized[index].eventId, /^evt_v2_[a-f0-9]{64}$/);
    assert.equal(normalized[index].clocks.emittedAt, emittedAt);
  }
});

test("V1 adapter preserves unknown occurredAt as null and requires real outbox created_at", () => {
  const event = adapt(tgDeleted());
  assert.equal(event.clocks.occurredAt, null);
  assert.equal(event.clocks.observedAt, observedAt);
  assert.equal(event.producer.version, "legacy-v1");
  assert.throws(() => adaptLegacyOutboxEventToV2(tgDeleted(), {}), /created_at is required/);
});

test("V1 adapter strips source-local entity clocks but preserves canonical identities", () => {
  const event = adapt(xTweet());
  assert.deepEqual(event.entityRefs, [{ kind: "author", canonicalId: "x:999" }]);
  assert.equal(event.evidenceRefs[0].sourceId, "x:tweet:123");
  assert.equal(event.evidenceRefs[0].occurredAt, occurredAt);
});

test("unknown schemas, mismatched outer identities and private source text are rejected", () => {
  const event = xTweet();
  assert.throws(() => adaptLegacyOutboxEventToV2({
    ...event, schemaVersion: "x-tweet-v99",
  }, { emittedAt }), /Unsupported event schema/);
  const mismatch = xTweet();
  mismatch.payload.registryEvent.eventKey += ":tampered";
  assert.throws(() => adapt(mismatch), /identity differ/);
  const privateText = xTweet();
  privateText.payload.timelineEvent.payload.privateText = "private message";
  assert.throws(() => adapt(privateText), /not an allowed field/);
  assert.throws(() => adaptLegacyOutboxEventToV2({
    ...event, sourceSystem: "twitter_research",
  }, { emittedAt }), /Unsupported legacy sourceSystem/);
});

test("legacy event emission cannot be later than the adapter's supplied outbox clock", () => {
  assert.throws(() => adaptLegacyOutboxEventToV2(xTweet(), {
    emittedAt: "2026-10-18T00:00:00Z",
  }), /observedAt cannot be later than emittedAt/);
});
