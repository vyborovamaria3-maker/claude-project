import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ensureFomoSnapshotSchema } from "./fomo-snapshot-schema";
import { buildFomoSnapshotRecord } from "./fomo-snapshot";
import { insertFomoSnapshotWithDb } from "./fomo-snapshot-store";
import type { SocialTimeline, TwitterStats } from "./social-intelligence";

const SIGNAL_AT = Date.parse("2025-01-01T12:00:00.000Z");

function makeX(timestamp = SIGNAL_AT - 60_000): TwitterStats & {
  lastUpdated: number;
  performance: { cached: boolean };
  collectionTruncated: boolean;
  meta: { matchedBeforeLimit: number; truncated: boolean };
} {
  return {
    symbol: "TEST",
    totalTweets: 3,
    totalViews: 1000,
    totalLikes: 30,
    totalRetweets: 5,
    uniqueMentioners: 3,
    botRiskScore: 10,
    anomalyCount: 0,
    lastUpdated: SIGNAL_AT - 30_000,
    performance: { cached: false },
    collectionTruncated: false,
    meta: { matchedBeforeLimit: 3, truncated: false },
    topTweets: [
      { id: "x-1", text: "🚀 great gem buy", author: "alice", likes: 10, retweets: 2, views: 300, timestamp, isSuspicious: false },
      { id: "x-2", text: "Strong organic breakout", author: "bob", likes: 8, retweets: 1, views: 250, timestamp: timestamp - 1_000, isSuspicious: false },
      { id: "x-3", text: "Early alpha discussion", author: "carol", likes: 12, retweets: 2, views: 450, timestamp: timestamp - 2_000, isSuspicious: false },
    ],
    shillers: [],
    aggregated: {
      totalEngagement: 55,
      engagementRate: 0.035,
      verifiedAuthors: 0,
      botRatio: 0.1,
    },
  };
}

function makeTg(timestamp = SIGNAL_AT - 40_000): SocialTimeline {
  return {
    mentions: 3,
    platforms: { telegram: 3 },
    origin: null,
    timeline: [
      { platform: "telegram", source_handle: "channel-a", source_name: "Channel A", source_url: null, text: "🚀 strong buy", occurred_at: new Date(timestamp).toISOString(), metrics: {} },
      { platform: "telegram", source_handle: "channel-b", source_name: "Channel B", source_url: null, text: "Good momentum", occurred_at: new Date(timestamp - 1_000).toISOString(), metrics: {} },
      { platform: "telegram", source_handle: "channel-c", source_name: "Channel C", source_url: null, text: "Early alpha", occurred_at: new Date(timestamp - 2_000).toISOString(), metrics: {} },
    ],
    meta: {
      matchedBeforeLimit: 3,
      returned: 3,
      truncated: false,
      matchedPlatforms: { telegram: 3 },
      uniqueSourcesBeforeLimit: 3,
      explicitTelegramCallsBeforeLimit: 1,
      firstMatchedAt: new Date(timestamp - 2_000).toISOString(),
      lastMatchedAt: new Date(timestamp).toISOString(),
    },
  };
}

describe("FOMO point-in-time snapshot capture", () => {
  it("recomputes scores at a fixed as-of time and labels bounded source samples partial", () => {
    const record = buildFomoSnapshotRecord({
      mint: "So11111111111111111111111111111111111111112",
      x: makeX(),
      tg: makeTg(),
      signalAt: SIGNAL_AT,
    });

    expect(record.scoreVersion).toBe("fomo-pressure-quality-v1");
    expect(record.maxInputObservedAt).toBeLessThanOrEqual(record.signalAt);
    expect(record.xCoverage).toBe("partial");
    expect(record.tgCoverage).toBe("partial");
    expect(record.qualityCoverage).toBeGreaterThanOrEqual(0);
    expect(record.qualityCoverage).toBeLessThanOrEqual(1);
    expect(record.inputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record.sourceMetaJson).not.toContain("great gem buy");
  });

  it("rejects social events timestamped after the signal", () => {
    expect(() => buildFomoSnapshotRecord({
      mint: "So11111111111111111111111111111111111111112",
      x: makeX(SIGNAL_AT + 1),
      tg: makeTg(),
      signalAt: SIGNAL_AT,
    })).toThrow("future_social_event");
  });

  it("persists one immutable snapshot per token/version/15-minute bucket", () => {
    const db = new Database(":memory:");
    try {
      ensureFomoSnapshotSchema(db);
      const mint = "So11111111111111111111111111111111111111112";
      const first = buildFomoSnapshotRecord({
        mint,
        x: makeX(),
        tg: makeTg(),
        signalAt: SIGNAL_AT,
      });
      const second = buildFomoSnapshotRecord({
        mint,
        x: makeX(SIGNAL_AT - 20_000),
        tg: makeTg(SIGNAL_AT - 15_000),
        signalAt: SIGNAL_AT + 30_000,
      });

      const saved = insertFomoSnapshotWithDb(db, first);
      const duplicate = insertFomoSnapshotWithDb(db, second);
      expect(saved.inserted).toBe(true);
      expect(duplicate.inserted).toBe(false);
      expect(duplicate.snapshotId).toBe(first.snapshotId);
      expect(db.prepare("SELECT COUNT(*) AS n FROM fomo_score_snapshots").get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });
});
