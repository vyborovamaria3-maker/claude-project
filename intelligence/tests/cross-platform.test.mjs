import test from "node:test";
import assert from "node:assert/strict";
import { formatTokenId } from "@claude-project/contracts";
import {
  CROSS_PLATFORM_SCORE_VERSION, computeCrossPlatformScores, validateCrossPlatformSnapshot, refreshTokenDailyCrossPlatform,
} from "../dist/index.js";

const token = formatTokenId("solana", "So11111111111111111111111111111111111111112");
const base = {
  canonicalTokenId: token, day: "2026-10-22", asOf: "2026-10-22T23:59:00Z",
  maxInputObservedAt: "2026-10-22T23:58:00Z",
  tgMentions: 20, tgUniqueAuthors: 8, tgCopypastaRatio: 0.1, tgSentimentScore: 0.5, tgScamRatio: 0.05,
  xMentions: 30, xUniqueAuthors: 12, xBotRatio: 0.2, xSentimentScore: 0.4,
  chainTrades: null, chainTransactions: 18, chainSwapEvidenceCount: 15, chainUniqueWallets: 9, chainVolumeUsd: null, chainLiquidityUsd: 50000,
  chainSmartMoneyBought: null, chainRugRisk: 0.1,
  tgMentionsZ1h: 1.2, xMentionsZ1h: 0.8, chainVolumeZ1h: 1.5,
  firstMentionTgAt: "2026-10-22T01:00:00Z", firstMentionXAt: "2026-10-22T02:00:00Z",
  firstTradeAt: null, firstSwapEvidenceAt: "2026-10-22T03:00:00Z",
};

test("cross-platform scores are versioned and missing metrics stay null", () => {
  const scores = computeCrossPlatformScores({ ...base, tgCopypastaRatio: null, xBotRatio: null, chainRugRisk: null });
  assert.equal(scores.scoreVersion, CROSS_PLATFORM_SCORE_VERSION);
  assert.equal(scores.credibilityScore, null);
  assert.ok(Math.abs(scores.riskScore - 0.05) < 1e-12);
  assert.equal(scores.momentumScore, 1.17);
  assert.ok(scores.dataConfidence < 1);
  assert.ok(scores.scoreReason.predictiveValidity.includes("not_established"));
});

test("snapshot validation preserves point-in-time boundaries and UTC day", () => {
  const snapshot = validateCrossPlatformSnapshot(base);
  assert.equal(snapshot.asOf, "2026-10-22T23:59:00.000Z");
  assert.ok(snapshot.dataConfidence < 1);
  assert.equal(snapshot.chainTrades, null);
  assert.match(snapshot.snapshotSha256, /^[0-9a-f]{64}$/);
  assert.throws(() => validateCrossPlatformSnapshot({ ...base, maxInputObservedAt: "2026-10-23T00:01:00Z" }), /Future-observed/);
  assert.doesNotThrow(() => validateCrossPlatformSnapshot({ ...base, asOf: "2026-10-23T00:00:00Z", maxInputObservedAt: "2026-10-23T00:00:00Z" }));
  assert.throws(() => validateCrossPlatformSnapshot({ ...base, asOf: "2026-10-21T23:59:00Z" }), /cannot precede/);
  assert.throws(() => validateCrossPlatformSnapshot({ ...base, xBotRatio: 1.2 }), /Invalid ratio/);
  assert.throws(() => validateCrossPlatformSnapshot({ ...base, firstSwapEvidenceAt: "2026-10-23T00:01:00Z" }), /Event time cannot be in the future/);
});

test("optional absent z-scores and explicit nulls produce the same immutable snapshot hash", () => {
  const without={...base}; delete without.tgMentionsZ1h; delete without.xMentionsZ1h; delete without.chainVolumeZ1h;
  assert.equal(validateCrossPlatformSnapshot(without).snapshotSha256,
    validateCrossPlatformSnapshot({...without,tgMentionsZ1h:null,xMentionsZ1h:null,chainVolumeZ1h:null}).snapshotSha256);
});

test("optional absent z-scores and explicit nulls produce the same immutable snapshot hash", () => {
  const without={...base}; delete without.tgMentionsZ1h; delete without.xMentionsZ1h; delete without.chainVolumeZ1h;
  assert.equal(validateCrossPlatformSnapshot(without).snapshotSha256,
    validateCrossPlatformSnapshot({...without,tgMentionsZ1h:null,xMentionsZ1h:null,chainVolumeZ1h:null}).snapshotSha256);
});

test("all-null sources do not manufacture zero attention or risk", () => {
  const input = Object.fromEntries(Object.keys(base).map((key) => [key, null]));
  Object.assign(input, { canonicalTokenId: token, day: "2026-10-22", asOf: "2026-10-22T23:59:00Z", maxInputObservedAt: "2026-10-22T23:58:00Z" });
  const scores = computeCrossPlatformScores(input);
  assert.equal(scores.attentionScore, null);
  assert.equal(scores.riskScore, null);
  assert.equal(scores.momentumScore, null);
});


test("refresh query separates transactions, supported swap evidence, and settled trades", async () => {
  let aggregateSql = "";
  const tx = {
    async query(sql) {
      if (sql.includes("WITH token_events AS")) {
        aggregateSql = sql;
        return { rows: [{
          max_input_observed_at: "2026-10-23T00:10:00Z",
          tg_mentions: "5", tg_unique_authors: "3", tg_copypasta_ratio: "0.1",
          tg_sentiment_score: "0.4", tg_scam_ratio: "0.02",
          x_mentions: "7", x_unique_authors: "4", x_bot_ratio: "0.2", x_sentiment_score: "0.3",
          chain_trades: null, chain_transactions: "4", chain_swap_evidence_count: "2",
          chain_unique_wallets: "2", chain_volume_usd: null, chain_liquidity_usd: null,
          chain_smart_money_bought: null, chain_rug_risk: null,
          tg_mentions_z_1h: null, x_mentions_z_1h: null, chain_volume_z_1h: null,
          first_mention_tg_at: "2026-10-22T01:00:00Z",
          first_mention_x_at: "2026-10-22T02:00:00Z",
          first_trade_at: null, first_swap_evidence_at: "2026-10-22T03:00:00Z",
          tg_coverage: "partial", x_coverage: "partial", blockchain_coverage: "partial",
        }] };
      }
      if (sql.includes("INSERT INTO token_daily_cross_platform")) {
        return { rows: [{ canonical_token_id: token }] };
      }
      throw new Error("unexpected query in refresh test");
    },
  };
  const snapshot = await refreshTokenDailyCrossPlatform(
    tx, token, "2026-10-22", "2026-10-23T00:15:00Z",
  );
  assert.match(aggregateSql, /timeline_kind='chain_transaction'/);
  assert.match(aggregateSql, /timeline_kind='trade_executed'/);
  assert.match(aggregateSql, /blockchain_swap_evidence_revisions/);
  assert.match(aggregateSql, /scope='token_swap_evidence_revisions'/);
  assert.match(aggregateSql, /fe\.max_historical_event_observed_at/);
  assert.match(aggregateSql, /inbox\.ingested_at <= \$3::timestamptz/);
  assert.match(aggregateSql, /MAX\(GREATEST\(observed_at,ingested_at\)\)/);
  assert.match(aggregateSql, /AVG\(.*\) FILTER \(WHERE source_system='tg' AND timeline_kind='tg_message_published'\)/);
  assert.match(aggregateSql, /COUNT\(DISTINCT author\.canonical_id\) FILTER \(WHERE e\.source_system='x' AND e\.timeline_kind='tweet_published'\)/);
  assert.match(aggregateSql, /jsonb_typeof\(payload->'smart_money_bought'\)='boolean'/);
  assert.doesNotMatch(aggregateSql, /WHEN \(SELECT coverage_status FROM trade_coverage\)='complete' THEN 0/);
  assert.match(aggregateSql, /jsonb_typeof\(payload->'smart_money_bought'\)='boolean'/);
  assert.doesNotMatch(aggregateSql, /WHEN \(SELECT coverage_status FROM trade_coverage\)='complete' THEN 0/);
  assert.match(aggregateSql, /created_at <= \$3::timestamptz/);
  assert.match(aggregateSql, /AT TIME ZONE 'UTC'/);
  assert.equal(aggregateSql.split("deleted.event_kind='message_deleted'").length-1,2,
    "daily and first-mention metrics must both exclude delivered deletions");
  assert.equal(aggregateSql.split("deleted.ingested_at<=$3::timestamptz").length-1,2,
    "future deletions must not leak into earlier as-of metrics");
  assert.equal(snapshot.chainTransactions, 4);
  assert.equal(snapshot.chainSwapEvidenceCount, 2);
  assert.equal(snapshot.chainTrades, null);
  assert.equal(snapshot.chainVolumeUsd, null);
  assert.equal(snapshot.firstTradeAt, null);
  assert.equal(snapshot.firstSwapEvidenceAt, "2026-10-22T03:00:00.000Z");
});
