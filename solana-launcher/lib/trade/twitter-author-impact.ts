export type PriceHorizon = "m5" | "m15" | "h1" | "h4" | "h24";

export interface ImpactPostInput {
  id: string;
  timestamp: number | null;
  views: number;
  viewsKnown: boolean;
  likes: number;
  retweets: number;
  replies: number;
  quotes: number;
  bookmarks: number;
}

export interface PriceCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface ReactionSummary {
  sampleCount: number;
  knownViewsCount: number;
  avgViews: number;
  medianViews: number;
  avgLikes: number;
  medianLikes: number;
  avgRetweets: number;
  avgReplies: number;
  avgQuotes: number;
  avgBookmarks: number;
  engagementPerView: number;
  viewsPerFollower: number;
  engagementPerFollower: number;
  coefficientOfVariation: number;
  spikeRatio: number;
  viralShare: number;
}

export interface SinglePostImpact {
  basePrice: number | null;
  m5: number | null;
  m15: number | null;
  h1: number | null;
  h4: number | null;
  h24: number | null;
  maxUp24h: number | null;
  maxDown24h: number | null;
}

export interface HorizonSummary {
  samples: number;
  averageChange: number | null;
  medianChange: number | null;
  positiveRate: number | null;
}

export interface PriceImpactSummary {
  horizons: Record<PriceHorizon, HorizonSummary>;
  averageMaxUp24h: number | null;
  averageMaxDown24h: number | null;
  direction: "positive" | "mixed" | "negative" | "insufficient";
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function nullableMean(values: number[]): number | null {
  return values.length > 0 ? mean(values) : null;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function nullableMedian(values: number[]): number | null {
  return values.length > 0 ? median(values) : null;
}

function populationStd(values: number[]): number {
  if (values.length <= 1) return 0;
  const avg = mean(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - avg) ** 2, 0) /
      values.length,
  );
}

function normalizeMs(value: number): number {
  return value > 0 && value < 1e12 ? value * 1000 : value;
}

function pctChange(base: number, value: number): number | null {
  if (!Number.isFinite(base) || !Number.isFinite(value) || base <= 0) {
    return null;
  }
  return ((value - base) / base) * 100;
}

export function summarizeReactions(
  posts: ImpactPostInput[],
  followers: number,
): ReactionSummary {
  const safeFollowers = Math.max(0, followers);
  const known = posts.filter((post) => post.viewsKnown);
  const views = known.map((post) => finiteNonNegative(post.views));
  const likes = posts.map((post) => finiteNonNegative(post.likes));
  const retweets = posts.map((post) => finiteNonNegative(post.retweets));
  const replies = posts.map((post) => finiteNonNegative(post.replies));
  const quotes = posts.map((post) => finiteNonNegative(post.quotes));
  const bookmarks = posts.map((post) => finiteNonNegative(post.bookmarks));

  const avgViews = mean(views);
  const medianViews = median(views);
  const avgLikes = mean(likes);
  const avgRetweets = mean(retweets);
  const avgReplies = mean(replies);
  const avgQuotes = mean(quotes);
  const avgBookmarks = mean(bookmarks);

  const avgEngagement =
    avgLikes + avgRetweets + avgReplies + avgQuotes + avgBookmarks;

  const stdViews = populationStd(views);
  const coefficientOfVariation =
    views.length > 0 ? stdViews / Math.max(avgViews, 1) : 0;

  const maxViews = views.length > 0 ? Math.max(...views) : 0;
  const spikeRatio =
    views.length > 0 ? maxViews / Math.max(medianViews, 1) : 0;

  const viralThreshold = Math.max(medianViews * 3, 1);
  const viralShare =
    views.length > 0
      ? views.filter((value) => value >= viralThreshold).length / views.length
      : 0;

  return {
    sampleCount: posts.length,
    knownViewsCount: known.length,
    avgViews,
    medianViews,
    avgLikes,
    medianLikes: median(likes),
    avgRetweets,
    avgReplies,
    avgQuotes,
    avgBookmarks,
    engagementPerView:
      avgViews > 0 ? avgEngagement / avgViews : 0,
    viewsPerFollower:
      safeFollowers > 0 ? avgViews / safeFollowers : 0,
    engagementPerFollower:
      safeFollowers > 0 ? avgEngagement / safeFollowers : 0,
    coefficientOfVariation,
    spikeRatio,
    viralShare,
  };
}

function sortedCandles(candles: PriceCandle[]): PriceCandle[] {
  return candles
    .filter(
      (candle) =>
        Number.isFinite(candle.timestamp) &&
        Number.isFinite(candle.close) &&
        candle.close > 0,
    )
    .map((candle) => ({
      ...candle,
      timestamp: normalizeMs(candle.timestamp),
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

function nearestBasePrice(
  candles: PriceCandle[],
  timestamp: number,
): number | null {
  const target = normalizeMs(timestamp);
  let previous: PriceCandle | null = null;

  for (const candle of candles) {
    if (candle.timestamp <= target) {
      previous = candle;
      continue;
    }
    break;
  }

  if (previous && target - previous.timestamp <= 20 * 60_000) {
    return previous.close;
  }

  const next = candles.find(
    (candle) =>
      candle.timestamp >= target &&
      candle.timestamp - target <= 5 * 60_000,
  );

  return next?.open || next?.close || null;
}

function priceNearTarget(
  candles: PriceCandle[],
  target: number,
  toleranceMs: number,
): number | null {
  let best: PriceCandle | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candle of candles) {
    if (candle.timestamp < target) continue;
    const distance = candle.timestamp - target;
    if (distance <= toleranceMs && distance < bestDistance) {
      best = candle;
      bestDistance = distance;
    }
  }

  return best?.close || null;
}

export function computePostPriceImpact(
  timestamp: number | null,
  rawCandles: PriceCandle[],
): SinglePostImpact {
  if (timestamp == null || !Number.isFinite(timestamp)) {
    return {
      basePrice: null,
      m5: null,
      m15: null,
      h1: null,
      h4: null,
      h24: null,
      maxUp24h: null,
      maxDown24h: null,
    };
  }

  const candles = sortedCandles(rawCandles);
  const ts = normalizeMs(timestamp);
  const basePrice = nearestBasePrice(candles, ts);

  if (basePrice == null) {
    return {
      basePrice: null,
      m5: null,
      m15: null,
      h1: null,
      h4: null,
      h24: null,
      maxUp24h: null,
      maxDown24h: null,
    };
  }

  const horizon = (
    deltaMs: number,
    toleranceMs: number,
  ): number | null => {
    const price = priceNearTarget(candles, ts + deltaMs, toleranceMs);
    return price == null ? null : pctChange(basePrice, price);
  };

  const within24h = candles.filter(
    (candle) =>
      candle.timestamp >= ts &&
      candle.timestamp <= ts + 24 * 60 * 60_000,
  );

  const maxHigh =
    within24h.length > 0
      ? Math.max(...within24h.map((candle) => candle.high || candle.close))
      : null;

  const minLow =
    within24h.length > 0
      ? Math.min(...within24h.map((candle) => candle.low || candle.close))
      : null;

  return {
    basePrice,
    m5: horizon(5 * 60_000, 7 * 60_000),
    m15: horizon(15 * 60_000, 10 * 60_000),
    h1: horizon(60 * 60_000, 20 * 60_000),
    h4: horizon(4 * 60 * 60_000, 35 * 60_000),
    h24: horizon(24 * 60 * 60_000, 60 * 60_000),
    maxUp24h:
      maxHigh == null ? null : pctChange(basePrice, maxHigh),
    maxDown24h:
      minLow == null ? null : pctChange(basePrice, minLow),
  };
}

function summarizeHorizon(
  impacts: SinglePostImpact[],
  horizon: PriceHorizon,
): HorizonSummary {
  const values = impacts
    .map((impact) => impact[horizon])
    .filter((value): value is number => value != null && Number.isFinite(value));

  return {
    samples: values.length,
    averageChange: nullableMean(values),
    medianChange: nullableMedian(values),
    positiveRate:
      values.length > 0
        ? values.filter((value) => value > 0).length / values.length
        : null,
  };
}

export function summarizePriceImpacts(
  impacts: SinglePostImpact[],
): PriceImpactSummary {
  const horizons: Record<PriceHorizon, HorizonSummary> = {
    m5: summarizeHorizon(impacts, "m5"),
    m15: summarizeHorizon(impacts, "m15"),
    h1: summarizeHorizon(impacts, "h1"),
    h4: summarizeHorizon(impacts, "h4"),
    h24: summarizeHorizon(impacts, "h24"),
  };

  const maxUp = impacts
    .map((impact) => impact.maxUp24h)
    .filter((value): value is number => value != null && Number.isFinite(value));

  const maxDown = impacts
    .map((impact) => impact.maxDown24h)
    .filter((value): value is number => value != null && Number.isFinite(value));

  const directional = [
    horizons.h1.averageChange,
    horizons.h4.averageChange,
    horizons.h24.averageChange,
  ].filter((value): value is number => value != null);

  let direction: PriceImpactSummary["direction"] = "insufficient";

  if (directional.length >= 2) {
    const avg = mean(directional);
    if (avg >= 5) direction = "positive";
    else if (avg <= -5) direction = "negative";
    else direction = "mixed";
  }

  return {
    horizons,
    averageMaxUp24h: nullableMean(maxUp),
    averageMaxDown24h: nullableMean(maxDown),
    direction,
  };
}
