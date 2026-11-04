import { describe, expect, it } from "vitest";
import {
  DEFAULT_SOCIAL_OPTIONS,
  deriveSocialMetrics,
  score,
  type SocialTimeline,
  type TwitterStats,
} from "./social-intelligence";

function makeX({
  duplicateText = false,
  botRisk = 10,
}: {
  duplicateText?: boolean;
  botRisk?: number;
} = {}): TwitterStats {
  const now = Date.now();
  const texts = duplicateText
    ? Array.from({ length: 4 }, () => "🚀 great gem buy")
    : [
        "🚀 great gem buy from independent users",
        "Strong organic breakout and good upside",
        "Early alpha with real discussion",
        "Good momentum, new holders discussing",
      ];

  return {
    symbol: "TEST",
    totalTweets: 12,
    totalViews: 20_000,
    totalLikes: 500,
    totalRetweets: 100,
    uniqueMentioners: duplicateText ? 2 : 4,
    botRiskScore: botRisk,
    anomalyCount: botRisk >= 80 ? 3 : 0,
    topTweets: texts.map((text, index) => ({
      id: `tweet-${index}`,
      text,
      author: duplicateText ? `promo-${index % 2}` : `author-${index}`,
      likes: 100,
      retweets: 20,
      views: 5_000,
      timestamp: now - (index + 1) * 60_000,
      isSuspicious: botRisk >= 80,
    })),
    shillers: [
      {
        handle: "promo-a",
        tweets: duplicateText ? 8 : 1,
        totalEngagement: 50,
        isBot: botRisk >= 80,
        followers: 1_000,
        postsCount: 100,
        isVerified: false,
      },
      {
        handle: "promo-b",
        tweets: duplicateText ? 8 : 1,
        totalEngagement: 60,
        isBot: botRisk >= 80,
        followers: 1_200,
        postsCount: 100,
        isVerified: false,
      },
    ],
    meta: {
      matchedBeforeLimit: 12,
      returned: 4,
      truncated: false,
      queryMode: "latest",
    },
    riskUniverse: {
      totalTweets: 12,
      uniqueAuthors: duplicateText ? 2 : 4,
      suspiciousTweets: botRisk >= 80 ? 4 : 0,
      botAccounts: botRisk >= 80 ? 2 : 0,
      botRiskScore: botRisk,
      botRatio: botRisk / 100,
      anomalyCount: botRisk >= 80 ? 3 : 0,
    },
    aggregated: {
      totalEngagement: 600,
      engagementRate: 0.03,
      verifiedAuthors: duplicateText ? 0 : 2,
      botRatio: botRisk / 100,
    },
  };
}

function makeTelegram(): SocialTimeline {
  const now = Date.now();
  const timeline = Array.from({ length: 4 }, (_, index) => ({
    platform: "telegram",
    event_type: "call",
    source_handle: `channel-${index}`,
    source_name: `Channel ${index}`,
    source_url: null,
    text: `🚀 great gem buy discussion ${index}`,
    occurred_at: new Date(now - (index + 1) * 60_000).toISOString(),
    metrics: { explicit_call: true },
  }));

  return {
    mentions: 12,
    platforms: { telegram: 12 },
    origin: timeline[0],
    timeline,
    meta: {
      matchedBeforeLimit: 12,
      returned: 4,
      truncated: false,
      matchedPlatforms: { telegram: 12 },
      uniqueSourcesBeforeLimit: 4,
      explicitTelegramCallsBeforeLimit: 4,
      firstMatchedAt: timeline[3].occurred_at,
    },
  };
}

function derive(x: TwitterStats | null, tg: SocialTimeline | null) {
  return deriveSocialMetrics(x, tg, null, null, null, [], DEFAULT_SOCIAL_OPTIONS);
}

describe("FOMO Pressure and Quality", () => {
  it("keeps the legacy FOMO score unchanged and exposes it as Pressure", () => {
    const result = derive(makeX(), makeTelegram());
    const rows = result.groups.find((group) => group.title === "Growth / Quality / Manipulation")?.rows;
    const legacy = rows?.find((row) => row.label === "FOMO score");
    const pressure = rows?.find((row) => row.label === "FOMO Pressure");

    expect(legacy?.value).toBe(score(result.fomoPressure));
    expect(pressure?.value).toBe(legacy?.value);
    expect(result.fomoPressure).toBeGreaterThanOrEqual(0);
    expect(result.fomoPressure).toBeLessThanOrEqual(100);
  });

  it("reports usable-component coverage separately from the quality score", () => {
    const bothSources = derive(makeX(), makeTelegram());
    const xOnly = derive(makeX(), null);
    const empty = derive(null, null);

    expect(bothSources.fomoQualityCoverage).toBeCloseTo(1, 5);
    expect(xOnly.fomoQualityCoverage).toBeCloseTo(0.775, 5);
    expect(empty.fomoQualityCoverage).toBe(0);
    expect(empty.fomoQuality).toBe(0);

    const coverageRow = bothSources.groups
      .find((group) => group.title === "Growth / Quality / Manipulation")
      ?.rows.find((row) => row.label === "FOMO Quality feature coverage");
    expect(coverageRow?.value).toBe("100.0%");
  });

  it("scores duplicate, suspicious promotion lower on Quality than a cleaner sample", () => {
    const clean = derive(makeX(), makeTelegram());
    const manipulated = derive(
      makeX({ duplicateText: true, botRisk: 95 }),
      makeTelegram(),
    );

    expect(clean.fomoQuality).toBeGreaterThan(manipulated.fomoQuality);
    expect(manipulated.fomoQuality).toBeGreaterThanOrEqual(0);
    expect(manipulated.fomoQuality).toBeLessThanOrEqual(100);
  });
});
