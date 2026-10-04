import { describe, expect, it } from "vitest";
import { computeAQS, type ProfileInput } from "./audience-quality-score";

function post(views: number, likes: number, retweets: number) {
  return { views, likes, retweets, replies: 0, quotes: 0, bookmarks: 0 };
}

describe("computeAQS", () => {
  it("scores a healthy established account highly", () => {
    const input: ProfileInput = {
      followers: 84_200,
      following: 1_200,
      postsCount: 8_400,
      createdAt: "2015-03-12",
      verified: false,
      blueVerified: true,
      listedCount: 340,
      favouritesCount: 22_000,
      mediaCount: 1_800,
      recentPosts: Array.from({ length: 20 }, (_, i) =>
        post(40_000 + i * 400, 1_500 + i * 20, 120 + i * 3),
      ),
    };

    const result = computeAQS(input, Date.parse("2026-09-21T12:00:00Z"));

    expect(result.aqs).toBeGreaterThan(75);
    expect(result.confidence).toBe("High");
    expect(result.organicRange.low).toBeGreaterThan(0);
    expect(result.organicRange.high).toBeLessThanOrEqual(input.followers);
    expect(result.flags).not.toContain("views far below follower count");
  });

  it("penalizes inflated followers with weak reach and engagement", () => {
    const input: ProfileInput = {
      followers: 200_000,
      following: 500,
      postsCount: 12_000,
      createdAt: "2018-01-01",
      verified: false,
      blueVerified: false,
      listedCount: 50,
      favouritesCount: 10_000,
      mediaCount: 900,
      recentPosts: Array.from({ length: 20 }, (_, i) =>
        post(1_200 + i * 10, 5 + (i % 3), 1),
      ),
    };

    const result = computeAQS(input, Date.parse("2026-09-21T12:00:00Z"));

    expect(result.aqs).toBeLessThan(35);
    expect(result.signals.s2).toBeLessThan(30);
    expect(result.signals.s5).toBeLessThan(30);
    expect(result.flags).toContain("low engagement per follower");
    expect(result.flags).toContain("views far below follower count");
    expect(result.flags).toContain("suspicious like ratio");
  });

  it("detects follow-for-follow and young account patterns", () => {
    const input: ProfileInput = {
      followers: 5_000,
      following: 4_800,
      postsCount: 900,
      createdAt: "2026-06-01",
      verified: false,
      blueVerified: false,
      listedCount: 3,
      favouritesCount: 800,
      mediaCount: 50,
      recentPosts: Array.from({ length: 8 }, () => post(250, 2, 0)),
    };

    const result = computeAQS(input, Date.parse("2026-09-21T12:00:00Z"));

    expect(result.aqs).toBeLessThan(30);
    expect(result.confidence).toBe("Medium");
    expect(result.flags).toContain("follow-for-follow pattern");
    expect(result.flags).toContain("very young account");
  });

  it("handles zero followers and empty posts without NaN", () => {
    const input: ProfileInput = {
      followers: 0,
      following: 0,
      postsCount: 0,
      createdAt: null,
      verified: false,
      blueVerified: false,
      listedCount: 0,
      favouritesCount: 0,
      mediaCount: 0,
      recentPosts: [],
    };

    const result = computeAQS(input, Date.parse("2026-09-21T12:00:00Z"));

    expect(result.aqs).toBe(0);
    expect(result.organicRange).toEqual({ low: 0, high: 0 });
    expect(result.confidence).toBe("Low");
    expect(Number.isFinite(result.metrics.viewsPerFollower)).toBe(true);
    expect(result.flags).not.toContain("very young account");
  });

  it("does not treat unknown createdAt as a young account", () => {
    const input: ProfileInput = {
      followers: 10_000,
      following: 500,
      postsCount: 2_000,
      createdAt: null,
      verified: false,
      blueVerified: false,
      listedCount: 20,
      favouritesCount: 2_000,
      mediaCount: 100,
      recentPosts: Array.from({ length: 8 }, () => post(2_000, 70, 10)),
    };

    const result = computeAQS(input, Date.parse("2026-09-21T12:00:00Z"));
    expect(result.flags).not.toContain("very young account");
  });
});
