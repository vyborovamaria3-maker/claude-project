import { describe, expect, it } from "vitest";
import {
  computePostPriceImpact,
  summarizePriceImpacts,
  summarizeReactions,
  type PriceCandle,
} from "./twitter-author-impact";

describe("twitter author impact", () => {
  const start = Date.UTC(2026, 8, 21, 12, 0, 0);

  const candles: PriceCandle[] = Array.from({ length: 25 }, (_, i) => {
    const close = 100 + i;
    return {
      timestamp: start + i * 60 * 60_000,
      open: close - 0.2,
      high: close + 1,
      low: close - 1,
      close,
    };
  });

  it("computes post-to-price changes without claiming causality", () => {
    const impact = computePostPriceImpact(start, candles);
    expect(impact.h1).toBeCloseTo(1, 5);
    expect(impact.h4).toBeCloseTo(4, 5);
    expect(impact.h24).toBeCloseTo(24, 5);
    expect(impact.maxUp24h).toBeGreaterThan(20);
  });

  it("summarizes positive historical price moves", () => {
    const impacts = [
      computePostPriceImpact(start, candles),
      computePostPriceImpact(start + 60 * 60_000, candles),
    ];
    const summary = summarizePriceImpacts(impacts);
    expect(summary.horizons.h4.samples).toBe(2);
    expect(summary.horizons.h4.positiveRate).toBe(1);
    expect(summary.direction).toBe("positive");
  });

  it("summarizes audience reaction metrics", () => {
    const summary = summarizeReactions(
      [
        {
          id: "1",
          timestamp: start,
          views: 10_000,
          viewsKnown: true,
          likes: 500,
          retweets: 100,
          replies: 50,
          quotes: 10,
          bookmarks: 20,
        },
        {
          id: "2",
          timestamp: start + 1,
          views: 20_000,
          viewsKnown: true,
          likes: 1_000,
          retweets: 200,
          replies: 80,
          quotes: 20,
          bookmarks: 40,
        },
      ],
      50_000,
    );

    expect(summary.avgViews).toBe(15_000);
    expect(summary.medianViews).toBe(15_000);
    expect(summary.viewsPerFollower).toBeCloseTo(0.3, 5);
    expect(summary.engagementPerView).toBeGreaterThan(0);
  });
});
