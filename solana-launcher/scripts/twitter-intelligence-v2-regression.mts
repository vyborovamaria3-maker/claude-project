import assert from "node:assert/strict";
import { buildTwitterIntelligenceV2, validateTwitterIntelligenceV2, type TwitterHistoryRowV2 } from "../lib/trade/twitter-intelligence-v2.ts";

const now = Date.UTC(2026, 8, 23, 12, 0, 0);
const rows: TwitterHistoryRowV2[] = [];
let id = 0;
function add(minAgo: number, author: string, text: string, suspicious = false, followers = 10_000) {
  const ts = now - minAgo * 60_000;
  rows.push({
    tweetId: `t${++id}`, author, text, url: text.includes("http") ? "https://example.com/x" : null,
    views: 1000, likes: 50, retweets: 10, replies: 5, isVerified: followers > 50_000,
    isSuspicious: suspicious, suspicionScore: suspicious ? 0.9 : 0.05, postedAt: ts, fetchedAt: now - 30_000,
    followers, postsCount: 5000, accountVerified: followers > 50_000, firstSeenAt: now - 500 * 86_400_000,
    botScore: suspicious ? 0.9 : 0.1, isBot: suspicious,
  });
}

// Historical baseline: 20 non-empty 15m buckets with low activity.
for (let bucket = 8; bucket < 28; bucket += 1) {
  add(bucket * 15 + 2, `hist${bucket}`, `historical ${bucket}`);
}
// Current burst: broad organic activity plus a small duplicated coordinated cohort.
for (let i = 0; i < 12; i += 1) add(2 + (i % 5), `organic${i}`, `unique narrative ${i}`, false, 5_000 + i * 2_000);
for (let i = 0; i < 5; i += 1) add(4 + i, `bot${i}`, "same promo http://example.com/x", true, 100);

const result = buildTwitterIntelligenceV2({ mint: "Mint111111111111111111111111111111111111", rows, nowMs: now, market: { priceChange1h: 0.2, volume1h: 50_000, stale: false } });
validateTwitterIntelligenceV2(result);
assert.equal(result.schemaVersion, "twitter-intelligence-v2.0");
assert.ok(result.baselines.mentions15m.sampleBuckets >= 12);
assert.ok((result.baselines.mentions15m.robustZ ?? 0) > 1);
assert.ok(result.scores.coordinationRisk.value != null && result.scores.coordinationRisk.value >= 0 && result.scores.coordinationRisk.value <= 100);
assert.ok(result.scores.contradiction.value != null && result.scores.contradiction.value >= 0 && result.scores.contradiction.value <= 100);
assert.ok(result.confidence.value >= 0 && result.confidence.value <= 1);
assert.ok(result.confidence.horizons.h24 <= result.confidence.horizons.m15);
assert.ok(result.unknowns.includes("historical_influencer_outcomes_not_in_v10_27"));
assert.ok(result.snapshotId.startsWith("twitter-v2-"));
console.log(`[twitter-intelligence-v2-regression] OK: snapshot=${result.snapshotId} confidence=${result.confidence.value.toFixed(3)} coordination=${result.coordination.score.toFixed(1)} contradiction=${result.scores.contradiction.value?.toFixed(1)}`);
