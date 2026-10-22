import test from "node:test";
import assert from "node:assert/strict";
import { formatTokenId } from "@claude-project/contracts";
import { FEATURES_V2, FEATURES_V3, validateFeatureSnapshot } from "../dist/index.js";

const token = formatTokenId("solana", "So11111111111111111111111111111111111111112");
const v1Fields = {
  mentions_5m: 1, mentions_15m: 2, mentions_1h: 3, unique_authors: 2, unique_sources: 1,
  velocity: 1, acceleration: 0, sentiment_bullish_ratio: null, bot_ratio: null,
  smart_money_bought_at: null, liquidity_usd: null, volume_24h_usd: null,
  holder_concentration: null, decoder_coverage: "swap_only", history_coverage: "partial", data_confidence: 0.5,
};

test("FEATURES_V2 requires sentiment, copypasta, narrative and velocity fields", () => {
  const result = validateFeatureSnapshot({
    canonicalTokenId: token, asOf: "2026-10-22T12:00:00Z", maxInputObservedAt: "2026-10-22T11:59:00Z",
    featureVersion: FEATURES_V2.version,
    features: { ...v1Fields, sentiment_score: -0.2, copypasta_ratio: null, narrative_id: null, velocity_5m: 1.2, velocity_1h: null },
  });
  assert.equal(result.featureVersion, "features-v2");
  assert.equal(result.features.copypasta_ratio, null);
  assert.throws(() => validateFeatureSnapshot({
    canonicalTokenId: token, asOf: "2026-10-22T12:00:00Z", maxInputObservedAt: "2026-10-22T11:59:00Z",
    featureVersion: FEATURES_V2.version, features: { ...v1Fields, sentiment_score: 2, copypasta_ratio: null, narrative_id: null, velocity_5m: 1, velocity_1h: 1 },
  }), /sentiment_score/);
});

test("FEATURES_V3 adds embedding reference, cluster and coherence while retaining unknown values as null", () => {
  const result = validateFeatureSnapshot({
    canonicalTokenId: token, asOf: "2026-10-22T12:00:00Z", maxInputObservedAt: "2026-10-22T11:59:00Z",
    featureVersion: FEATURES_V3.version,
    features: {
      ...v1Fields, sentiment_score: null, copypasta_ratio: null, narrative_id: null, velocity_5m: null, velocity_1h: null,
      embedding_ref: null, cluster_id: null, coherence_score: null,
    },
  });
  assert.equal(result.featureVersion, "features-v3");
  assert.equal(result.features.embedding_ref, null);
});
