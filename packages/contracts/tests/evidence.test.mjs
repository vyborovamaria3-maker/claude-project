import test from "node:test";
import assert from "node:assert/strict";
import { buildEvidenceRef, validateEvidenceRef } from "../dist/index.js";

const NOW = "2026-10-17T20:30:00Z";
const SIG = "1".repeat(64);

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

test("chain evidence accepts only a valid Solana transaction signature", () => {
  const sol = buildEvidenceRef({sourceKind:"chain_tx",chain:"solana",transactionId:SIG,observedAt:NOW});
  assert.equal(sol.sourceId, "chain:tx:solana:" + SIG);
  assert.throws(() => buildEvidenceRef({sourceKind:"chain_tx",chain:"solana",transactionId:"bad",observedAt:NOW}), /signature/);
  assert.throws(() => buildEvidenceRef({sourceKind:"chain_tx",chain:"ethereum",transactionId:"0x"+"a".repeat(64),observedAt:NOW}), /Invalid chain/);
});

test("malformed provenance or ambiguous clocks are rejected", () => {
  assert.throws(() => buildEvidenceRef({sourceKind:"tg_message",sourceAccountId:"@durov",messageId:"1",observedAt:NOW}), /Stable numeric/);
  assert.throws(() => buildEvidenceRef({sourceKind:"tg_message",sourceAccountId:"-0",messageId:"1",observedAt:NOW}), /Stable numeric/);
  assert.throws(() => buildEvidenceRef({sourceKind:"x_tweet",tweetId:"abc",observedAt:NOW}), /Tweet ID/);
  assert.throws(() => buildEvidenceRef({sourceKind:"x_tweet",tweetId:"12",observedAt:"2026-10-17T20:00:00"}), /timezone/);
  assert.throws(() => buildEvidenceRef({sourceKind:"x_tweet",tweetId:"12",observedAt:NOW,provider:" "}), /Invalid provider/);
});


test("Discord evidence identity binds guild, channel and message Snowflakes", () => {
  const ref = buildEvidenceRef({
    sourceKind: "discord_message",
    guildId: "12345678901234567",
    channelId: "22345678901234567",
    messageId: "32345678901234567",
    occurredAt: "2026-11-18T18:00:00Z",
    observedAt: "2026-11-18T18:00:02Z",
    provider: "discord-gateway",
    parserVersion: "discord-collector-v1",
  });
  assert.equal(ref.sourceId, "discord:message:12345678901234567:22345678901234567:32345678901234567");
  assert.equal(validateEvidenceRef(ref).sourceId, ref.sourceId);
  assert.throws(() => buildEvidenceRef({
    sourceKind: "discord_message", guildId: "1", channelId: "22345678901234567",
    messageId: "32345678901234567", observedAt: NOW,
  }), /Snowflakes/);
  assert.throws(() => validateEvidenceRef({...ref, sourceId: "discord:message:1:2:3"}), /Discord message evidence/);
});


test("Discord evidence rejects Snowflake values above uint64 max", () => {
  const valid = "18446744073709551615";
  assert.doesNotThrow(() => buildEvidenceRef({
    sourceKind:"discord_message",guildId:valid,channelId:valid,messageId:valid,observedAt:NOW,
  }));
  assert.throws(() => buildEvidenceRef({
    sourceKind:"discord_message",guildId:"18446744073709551616",
    channelId:"22345678901234567",messageId:"32345678901234567",observedAt:NOW,
  }), /Snowflakes/);
  const ref = buildEvidenceRef({
    sourceKind:"discord_message",guildId:"12345678901234567",
    channelId:"22345678901234567",messageId:"32345678901234567",observedAt:NOW,
  });
  assert.throws(() => validateEvidenceRef({...ref,
    sourceId:"discord:message:18446744073709551616:22345678901234567:32345678901234567",
  }), /Snowflakes/);
});
