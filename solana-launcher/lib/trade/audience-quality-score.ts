/**
 * Audience Quality Score (AQS)
 *
 * Heuristic audience-quality estimation using only profile and recent-post
 * metrics available from X GraphQL.
 *
 * This does NOT inspect individual followers and is NOT proof that a follower
 * is real or fake.
 */

export interface RecentPostInput {
  views: number;
  likes: number;
  retweets: number;
  replies: number;
  quotes: number;
  bookmarks: number;
}

export interface ProfileInput {
  followers: number;
  following: number;
  postsCount: number;
  createdAt: string | null;
  verified: boolean;
  blueVerified: boolean;
  listedCount: number;
  favouritesCount: number;
  mediaCount: number;
  recentPosts: RecentPostInput[];
}

export type AQSConfidence = "Low" | "Medium" | "High";

export interface AQSResult {
  aqs: number;
  organicRange: { low: number; high: number };
  confidence: AQSConfidence;
  signals: { s1: number; s2: number; s3: number; s4: number; s5: number };
  metrics: {
    avgViews: number;
    medianViews: number;
    avgLikes: number;
    viewsPerFollower: number;
    engagementPerFollower: number;
    likeRate: number;
    retweetRate: number;
    coefficientOfVariation: number;
    spikeRatio: number;
  };
  flags: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Clamp a finite number to [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Convert a numeric value to a finite non-negative number. */
function nonNegative(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

/** Arithmetic mean. Empty arrays return 0. */
export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + nonNegative(value), 0) / values.length;
}

/** Median. Empty arrays return 0. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.map(nonNegative).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Population standard deviation. Empty/single arrays return 0. */
export function std(values: number[]): number {
  if (values.length <= 1) return 0;
  const normalized = values.map(nonNegative);
  const avg = mean(normalized);
  const variance = normalized.reduce(
    (sum, value) => sum + (value - avg) ** 2,
    0,
  ) / normalized.length;
  return Math.sqrt(variance);
}

/**
 * Account age in years.
 * Unknown, invalid or future dates return null instead of being treated as new.
 */
function accountAgeYears(createdAt: string | null, nowMs: number): number | null {
  if (!createdAt) return null;
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs) || createdMs > nowMs) return null;
  return Math.max(0, nowMs - createdMs) / DAY_MS / 365;
}

/** Profile Health signal S1. */
function computeS1(input: ProfileInput, ageYears: number | null): number {
  const followers = nonNegative(input.followers);
  const following = nonNegative(input.following);
  const postsCount = nonNegative(input.postsCount);
  const listedCount = nonNegative(input.listedCount);

  const ratio = followers / Math.max(following, 1);
  const scoreRatio = clamp(ratio / 10, 0, 1) * 100;
  const scoreAge = ageYears == null ? 0 : clamp(ageYears / 5, 0, 1) * 100;
  const scorePosts = clamp(postsCount / 5000, 0, 1) * 100;
  const scoreListed = clamp(listedCount / 500, 0, 1) * 100;
  const bonusVerified = input.verified || input.blueVerified ? 10 : 0;

  return clamp(
    0.30 * scoreRatio +
      0.25 * scoreAge +
      0.15 * scorePosts +
      0.20 * scoreListed +
      bonusVerified,
    0,
    100,
  );
}

/** Reach signal S2. */
function computeS2(avgViews: number, followers: number, postCount: number): number {
  if (postCount === 0) return 0;
  const vpf = avgViews / Math.max(followers, 1);
  return clamp(vpf / 0.5, 0, 1) * 100;
}

/** Engagement signal S3. */
function computeS3(
  avgLikes: number,
  avgRetweets: number,
  avgViews: number,
  postCount: number,
): number {
  if (postCount === 0) return 0;
  const likeRate = avgLikes / Math.max(avgViews, 1);
  const rtRate = avgRetweets / Math.max(avgViews, 1);
  const scoreLike = clamp(likeRate / 0.05, 0, 1) * 100;
  const scoreRt = clamp(rtRate / 0.01, 0, 1) * 100;
  return 0.6 * scoreLike + 0.4 * scoreRt;
}

/** Consistency signal S4. */
function computeS4(cv: number, spikeRatio: number, postCount: number): number {
  if (postCount === 0) return 0;
  const scoreCv = clamp(1 - cv / 1.5, 0, 1) * 100;
  const scoreSpike = clamp(1 - (spikeRatio - 1) / 9, 0, 1) * 100;
  return 0.6 * scoreCv + 0.4 * scoreSpike;
}

/** Engagement-per-follower signal S5. */
function computeS5(avgLikes: number, followers: number, postCount: number): number {
  if (postCount === 0) return 0;
  const epf = avgLikes / Math.max(followers, 1);
  return clamp(epf / 0.02, 0, 1) * 100;
}

/** Confidence based on sample size and follower count. */
function computeConfidence(postCount: number, followers: number): AQSConfidence {
  if (postCount >= 20 && followers >= 10_000) return "High";
  if (postCount >= 8 && followers >= 1_000) return "Medium";
  return "Low";
}

/** Compute AQS from supplied profile + recent-post metrics. */
export function computeAQS(
  input: ProfileInput,
  nowMs: number = Date.now(),
): AQSResult {
  const followers = nonNegative(input.followers);
  const following = nonNegative(input.following);
  const recentPosts = Array.isArray(input.recentPosts) ? input.recentPosts : [];

  const views = recentPosts.map((post) => nonNegative(post.views));
  const likes = recentPosts.map((post) => nonNegative(post.likes));
  const retweets = recentPosts.map((post) => nonNegative(post.retweets));

  const postCount = recentPosts.length;
  const avgViews = mean(views);
  const medianViews = median(views);
  const avgLikes = mean(likes);
  const avgRetweets = mean(retweets);
  const stdViews = std(views);

  const coefficientOfVariation =
    postCount === 0 ? 0 : stdViews / Math.max(avgViews, 1);

  const maxViews = postCount === 0 ? 0 : Math.max(...views);
  const spikeRatio =
    postCount === 0 ? 0 : maxViews / Math.max(medianViews, 1);

  const viewsPerFollower = avgViews / Math.max(followers, 1);
  const engagementPerFollower = avgLikes / Math.max(followers, 1);
  const likeRate = avgLikes / Math.max(avgViews, 1);
  const retweetRate = avgRetweets / Math.max(avgViews, 1);

  const ageYears = accountAgeYears(input.createdAt, nowMs);

  const s1 = computeS1(input, ageYears);
  const s2 = computeS2(avgViews, followers, postCount);
  const s3 = computeS3(avgLikes, avgRetweets, avgViews, postCount);
  const s4 = computeS4(coefficientOfVariation, spikeRatio, postCount);
  const s5 = computeS5(avgLikes, followers, postCount);

  const aqs = clamp(
    0.15 * s1 +
      0.20 * s2 +
      0.25 * s3 +
      0.10 * s4 +
      0.30 * s5,
    0,
    100,
  );

  const confidenceFactor = clamp(postCount / 20, 0.3, 1.0);
  const pointEstimate = followers * (aqs / 100);
  const spread =
    followers * (1 - confidenceFactor) * 0.25 +
    followers * (1 - aqs / 100) * 0.15;

  const organicLow = Math.max(0, Math.round(pointEstimate - spread));
  const organicHigh = Math.min(followers, Math.round(pointEstimate + spread));

  const flags: string[] = [];

  if (s5 < 30) flags.push("low engagement per follower");
  if (s2 < 30) flags.push("views far below follower count");
  if (following > followers * 0.5) flags.push("follow-for-follow pattern");
  if (ageYears != null && ageYears < 1) flags.push("very young account");
  if (postCount > 0 && spikeRatio > 5) flags.push("viral spike distortion");
  if (postCount > 0 && coefficientOfVariation > 1.2) flags.push("unstable reach");
  if (postCount > 0 && likeRate < 0.005) flags.push("suspicious like ratio");

  return {
    aqs,
    organicRange: { low: organicLow, high: organicHigh },
    confidence: computeConfidence(postCount, followers),
    signals: { s1, s2, s3, s4, s5 },
    metrics: {
      avgViews,
      medianViews,
      avgLikes,
      viewsPerFollower,
      engagementPerFollower,
      likeRate,
      retweetRate,
      coefficientOfVariation,
      spikeRatio,
    },
    flags,
  };
}
