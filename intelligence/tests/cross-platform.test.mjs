import test from "node:test";
import assert from "node:assert/strict";
import { formatTokenId } from "@claude-project/contracts";
import {
  CROSS_PLATFORM_SCORE_VERSION, computeCrossPlatformScores, validateCrossPlatformSnapshot,
} from "../dist/index.js";

const token = formatTokenId("solana", "So11111111111111111111111111111111111111112");
const base = {
  canonicalTokenId: token, day: "2026-10-22", asOf: "2026-10-22T23:59:00Z",
  maxInputObservedAt: "2026-10-22T23:58:00Z",
  tgMentions: 20, tgUniqueAuthors: 8, tgCopypastaRatio: 0.1, tgSentimentScore: 0.5, tgScamRatio: 0.05,
  xMentions: 30, xUniqueAuthors: 12, xBotRatio: 0.2, xSentimentScore: 0.4,
  chainTrades: 15, chainUniqueWallets: 9, chainVolumeUsd: 15000, chainLiquidityUsd: 50000,
  chainSmartMoneyBought: 3, chainRugRisk: 0.1,
  tgMentionsZ1h: 1.2, xMentionsZ1h: 0.8, chainVolumeZ1h: 1.5,
  firstMentionTgAt: "2026-10-22T01:00:00Z", firstMentionXAt: "2026-10-22T02:00:00Z",
  firstTradeAt: "2026-10-22T03:00:00Z",
};

test("cross-platform scores are versioned and missing metrics stay null", () => {
  const scores = computeCrossPlatformScores({ ...base, tgCopypastaRatio: null, xBotRatio: null, chainRugRisk: null });
  assert.equal(scores.scoreVersion, CROSS_PLATFORM_SCORE_VERSION);
  assert.equal(scores.credibilityScore, null);
  assert.equal(scores.riskScore, 0.05);
  assert.equal(scores.momentumScore, 1.17);
  assert.ok(scores.dataConfidence < 1);
  assert.ok(scores.scoreReason.predictiveValidity.includes("not_established"));
});

test("snapshot validation preserves point-in-time boundaries and UTC day", () => {
  const snapshot = validateCrossPlatformSnapshot(base);
  assert.equal(snapshot.asOf, "2026-10-22T23:59:00.000Z");
  assert.equal(snapshot.dataConfidence, 1);
  assert.match(snapshot.snapshotSha256, /^[0-9a-f]{64}$/);
  assert.throws(() => validateCrossPlatformSnapshot({ ...base, maxInputObservedAt: "2026-10-23T00:01:00Z" }), /Future-observed/);
  assert.throws(() => validateCrossPlatformSnapshot({ ...base, asOf: "2026-10-23T00:00:00Z" }), /UTC day/);
  assert.throws(() => validateCrossPlatformSnapshot({ ...base, xBotRatio: 1.2 }), /Invalid ratio/);
});

test("all-null sources do not manufacture zero attention or risk", () => {
  const input = Object.fromEntries(Object.keys(base).map((key) => [key, null]));
  Object.assign(input, { canonicalTokenId: token, day: "2026-10-22", asOf: "2026-10-22T23:59:00Z", maxInputObservedAt: "2026-10-22T23:58:00Z" });
  const scores = computeCrossPlatformScores(input);
  assert.equal(scores.attentionScore, null);
  assert.equal(scores.riskScore, null);
  assert.equal(scores.momentumScore, null);
});
