import { createHash } from "node:crypto";

export const TWITTER_INTELLIGENCE_V2_SCHEMA_VERSION = "twitter-intelligence-v2.0";
export const TWITTER_INTELLIGENCE_V2_ENGINE_VERSION = "potapoff-v10.27";

export type TwitterHistoryRowV2 = {
  tweetId: string;
  author: string;
  text: string;
  url?: string | null;
  views: number;
  likes: number;
  retweets: number;
  replies: number;
  isVerified: boolean;
  isSuspicious: boolean;
  suspicionScore: number;
  postedAt: number | null;
  fetchedAt: number;
  followers: number | null;
  postsCount: number | null;
  accountVerified: boolean;
  firstSeenAt: number | null;
  botScore: number | null;
  isBot: boolean;
};

export type TwitterMarketContextV2 = {
  priceChange1h: number | null;
  volume1h: number | null;
  stale: boolean;
};

export type RobustBaselineV2 = {
  value: number;
  median: number | null;
  mad: number | null;
  robustZ: number | null;
  percentile: number | null;
  sampleBuckets: number;
  baselineWindow: "24h" | "7d" | "insufficient";
};

export type ScoreV2 = {
  value: number | null;
  confidence: number;
  evidenceKeys: string[];
  note: string;
};

export type TwitterContradictionV2 = {
  type:
    | "volume_without_breadth"
    | "concentrated_burst"
    | "social_without_market_confirmation"
    | "coordination_vs_organic"
    | "engagement_without_breadth";
  severity: number;
  description: string;
  evidenceKeys: string[];
};

export type TwitterIntelligenceV2 = {
  snapshotId: string;
  schemaVersion: typeof TWITTER_INTELLIGENCE_V2_SCHEMA_VERSION;
  engineVersion: typeof TWITTER_INTELLIGENCE_V2_ENGINE_VERSION;
  mint: string;
  createdAt: string;
  sourceMaxFetchedAt: number | null;
  windows: {
    m15: { mentions: number; uniqueAuthors: number; engagement: number; organicShare: number };
    h1: { mentions: number; uniqueAuthors: number; engagement: number; organicShare: number };
    h6: { mentions: number; uniqueAuthors: number; engagement: number; organicShare: number };
    h24: { mentions: number; uniqueAuthors: number; engagement: number; organicShare: number };
    d7: { mentions: number; uniqueAuthors: number; engagement: number; organicShare: number };
  };
  baselines: {
    mentions15m: RobustBaselineV2;
    uniqueAuthors15m: RobustBaselineV2;
    engagement15m: RobustBaselineV2;
    organicShare15m: RobustBaselineV2;
  };
  concentration: {
    rawTop1: number | null;
    rawTop5: number | null;
    rawTop10: number | null;
    weightedTop1: number | null;
    weightedTop5: number | null;
    weightedTop10: number | null;
    profileCoverage: number;
  };
  coordination: {
    duplicateTextRatio: number;
    temporalBurstRatio: number;
    linkOverlapRatio: number;
    suspiciousShare: number;
    score: number;
  };
  narrative: {
    activeBucketShare: number;
    persistentAuthorShare: number;
    diversity: number;
    novelty: number;
  };
  market: TwitterMarketContextV2;
  lifecycle: {
    stage: "ignition" | "acceleration" | "broad_discovery" | "saturation" | "exhaustion" | "decay" | "uncertain";
    confidence: number;
    rules: string[];
  };
  scores: {
    organicMomentum: ScoreV2;
    influencerCredibility: ScoreV2;
    narrativeDurability: ScoreV2;
    coordinationRisk: ScoreV2;
    socialMarketConfirmation: ScoreV2;
    contradiction: ScoreV2;
  };
  contradictions: TwitterContradictionV2[];
  confidence: {
    value: number;
    components: {
      dataCompleteness: number;
      sampleReliability: number;
      historicalCalibration: number;
      signalAgreement: number;
      freshness: number;
    };
    horizons: { m15: number; h1: number; h4: number; h24: number };
    penalties: string[];
  };
  freshness: {
    latestFetchedAt: number | null;
    ageMs: number | null;
  };
  unknowns: string[];
  sample: {
    totalRows7d: number;
    current15m: number;
    current1h: number;
    baselineBuckets: number;
  };
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BUCKET_MS = 15 * MINUTE;

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function finite(value: unknown, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function median(values: number[]): number | null {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

function percentile(value: number, baseline: number[]): number | null {
  const clean = baseline.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  let below = 0;
  let equal = 0;
  for (const item of clean) {
    if (item < value) below += 1;
    else if (item === value) equal += 1;
  }
  return (below + equal * 0.5) / clean.length;
}

function robustBaseline(value: number, baseline24h: number[], baseline7d: number[]): RobustBaselineV2 {
  const usable24 = baseline24h.filter(Number.isFinite);
  const chosen = usable24.length >= 12 ? usable24 : baseline7d.filter(Number.isFinite);
  const baselineWindow: RobustBaselineV2["baselineWindow"] = usable24.length >= 12
    ? "24h"
    : chosen.length >= 12
      ? "7d"
      : "insufficient";
  if (baselineWindow === "insufficient") {
    return { value, median: null, mad: null, robustZ: null, percentile: null, sampleBuckets: chosen.length, baselineWindow };
  }
  const med = median(chosen);
  if (med == null) return { value, median: null, mad: null, robustZ: null, percentile: null, sampleBuckets: chosen.length, baselineWindow: "insufficient" };
  const mad = median(chosen.map((item) => Math.abs(item - med))) ?? 0;
  // Flat baselines are common for sparse token activity. A zero MAD must not
  // erase a real spike, so use a conservative count-scale floor.
  const scale = Math.max(1, 1.4826 * mad, Math.sqrt(Math.abs(med) + 1) * 0.5);
  const robustZ = clamp((value - med) / scale, -8, 8);
  return {
    value,
    median: med,
    mad,
    robustZ,
    percentile: percentile(value, chosen),
    sampleBuckets: chosen.length,
    baselineWindow,
  };
}

function timestampOf(row: TwitterHistoryRowV2) {
  const candidate = finite(row.postedAt, 0) || finite(row.fetchedAt, 0);
  return candidate > 0 ? candidate : null;
}

function rowsSince(rows: TwitterHistoryRowV2[], nowMs: number, durationMs: number) {
  const start = nowMs - durationMs;
  return rows.filter((row) => {
    const ts = timestampOf(row);
    return ts != null && ts >= start && ts <= nowMs + MINUTE;
  });
}

function engagement(row: TwitterHistoryRowV2) {
  return Math.max(0, finite(row.likes))
    + Math.max(0, finite(row.retweets))
    + Math.max(0, finite(row.replies));
}

function windowMetrics(rows: TwitterHistoryRowV2[]) {
  const authors = new Set(rows.map((row) => row.author.trim().toLowerCase()).filter(Boolean));
  const organic = rows.filter((row) => !row.isSuspicious && !row.isBot).length;
  return {
    mentions: rows.length,
    uniqueAuthors: authors.size,
    engagement: rows.reduce((sum, row) => sum + engagement(row), 0),
    organicShare: rows.length ? organic / rows.length : 0,
  };
}

function normalizedText(value: string) {
  return String(value || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " <url> ")
    .replace(/[1-9a-hj-np-z]{32,44}/gi, " <address> ")
    .replace(/[^\p{L}\p{N}<>]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

function linkKey(row: TwitterHistoryRowV2) {
  // twitter_token_tweets.url is normally the tweet permalink, not campaign evidence.
  // Coordination link overlap must use links embedded in the tweet text itself.
  const raw = String(row.text || "").match(/https?:\/\/[^\s)\]}>,]+/i)?.[0] || "";
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/$/, "")}`;
  } catch {
    return raw.toLowerCase().slice(0, 180);
  }
}

function temporalBurstRatio(rows: TwitterHistoryRowV2[], nowMs: number) {
  if (rows.length < 3) return 0;
  const times = rows.map(timestampOf).filter((value): value is number => value != null).sort((a, b) => a - b);
  if (!times.length) return 0;
  let left = 0;
  let maxCount = 0;
  for (let right = 0; right < times.length; right += 1) {
    while (times[right] - times[left] > 2 * MINUTE) left += 1;
    maxCount = Math.max(maxCount, right - left + 1);
  }
  return clamp(maxCount / Math.max(1, rows.length));
}

function maxShare<T>(values: T[]) {
  if (!values.length) return 0;
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return Math.max(...counts.values()) / values.length;
}

function accountQuality(row: TwitterHistoryRowV2, nowMs: number) {
  const bot = clamp(row.botScore == null ? (row.isBot ? 1 : 0) : row.botScore);
  const authenticity = 1 - bot;
  const followerQuality = row.followers == null ? 0.35 : clamp(Math.log1p(Math.max(0, row.followers)) / Math.log1p(250_000));
  // firstSeenAt is POTAPoff observation tenure, NOT the X account creation date.
  const observedDays = row.firstSeenAt == null ? null : Math.max(0, (nowMs - row.firstSeenAt) / DAY);
  const observedTenure = observedDays == null ? 0.25 : clamp(Math.log1p(observedDays) / Math.log1p(365));
  const activityMaturity = row.postsCount == null ? 0.35 : clamp(Math.log1p(Math.max(0, row.postsCount)) / Math.log1p(50_000));
  const verified = row.accountVerified || row.isVerified ? 1 : 0;
  return clamp(authenticity * 0.55 + followerQuality * 0.2 + activityMaturity * 0.15 + observedTenure * 0.05 + verified * 0.05);
}

function concentration(rows: TwitterHistoryRowV2[], nowMs: number, weighted: boolean) {
  if (!rows.length) return { top1: null, top5: null, top10: null };
  const byAuthor = new Map<string, { count: number; quality: number }>();
  for (const row of rows) {
    const key = row.author.trim().toLowerCase();
    if (!key) continue;
    const existing = byAuthor.get(key) || { count: 0, quality: 0 };
    existing.count += 1;
    existing.quality = Math.max(existing.quality, accountQuality(row, nowMs));
    byAuthor.set(key, existing);
  }
  const contributions = [...byAuthor.values()].map((value) => weighted ? value.count * (0.5 + value.quality) : value.count).sort((a, b) => b - a);
  const total = contributions.reduce((sum, value) => sum + value, 0);
  const share = (n: number) => total > 0 ? contributions.slice(0, n).reduce((sum, value) => sum + value, 0) / total : null;
  return { top1: share(1), top5: share(5), top10: share(10) };
}

function bucketSeries(rows: TwitterHistoryRowV2[], nowMs: number) {
  const buckets = new Map<number, TwitterHistoryRowV2[]>();
  for (const row of rows) {
    const ts = timestampOf(row);
    if (ts == null || ts > nowMs + MINUTE || ts < nowMs - 7 * DAY) continue;
    const key = Math.floor(ts / BUCKET_MS) * BUCKET_MS;
    const list = buckets.get(key) || [];
    list.push(row);
    buckets.set(key, list);
  }
  const currentKey = Math.floor(nowMs / BUCKET_MS) * BUCKET_MS;
  const prior = [...buckets.entries()]
    .filter(([key]) => key < currentKey)
    .sort((a, b) => a[0] - b[0])
    .map(([key, bucketRows]) => ({ key, metrics: windowMetrics(bucketRows) }));
  return { currentKey, prior };
}

function scoreFromZ(z: number | null, fallback: number) {
  return z == null ? clamp(fallback / 100, 0, 1) * 100 : clamp(0.5 + z * 0.12, 0, 1) * 100;
}

function featureConfidence(base: number, sample: number, historyBuckets: number) {
  return clamp(base * (0.4 + 0.6 * clamp(sample / 20)) * (0.5 + 0.5 * clamp(historyBuckets / 24)));
}

function hashSnapshot(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

function extractMarketContextFromFeatures(features: Array<{ key?: string; label?: string; numericValue?: number | null; missing?: boolean }>): TwitterMarketContextV2 {
  const pick = (needles: string[]) => {
    const row = features.find((feature) => {
      const haystack = `${feature.key || ""} ${feature.label || ""}`.toLowerCase();
      return !feature.missing && needles.some((needle) => haystack.includes(needle));
    });
    const value = row?.numericValue;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  return {
    priceChange1h: pick(["price_1h_snapshot", "price 1h snapshot", "changeh1"]),
    volume1h: pick(["volume_1h", "volume 1h", "volumeh1"]),
    stale: Boolean(features.find((feature) => `${feature.key || ""} ${feature.label || ""}`.toLowerCase().includes("market stale") && feature.numericValue === 1)),
  };
}

export function buildTwitterIntelligenceV2(args: {
  mint: string;
  rows: TwitterHistoryRowV2[];
  nowMs?: number;
  market?: TwitterMarketContextV2;
}): TwitterIntelligenceV2 {
  const nowMs = finite(args.nowMs, Date.now()) || Date.now();
  const rows = args.rows.filter((row) => row && row.tweetId && row.author).slice(0, 20_000);
  const market = args.market || { priceChange1h: null, volume1h: null, stale: false };

  const m15Rows = rowsSince(rows, nowMs, 15 * MINUTE);
  const h1Rows = rowsSince(rows, nowMs, HOUR);
  const h6Rows = rowsSince(rows, nowMs, 6 * HOUR);
  const h24Rows = rowsSince(rows, nowMs, DAY);
  const d7Rows = rowsSince(rows, nowMs, 7 * DAY);

  const windows = {
    m15: windowMetrics(m15Rows),
    h1: windowMetrics(h1Rows),
    h6: windowMetrics(h6Rows),
    h24: windowMetrics(h24Rows),
    d7: windowMetrics(d7Rows),
  };

  const { prior } = bucketSeries(rows, nowMs);
  const prior24 = prior.filter((bucket) => bucket.key >= nowMs - DAY);
  const prior7d = prior.filter((bucket) => bucket.key >= nowMs - 7 * DAY);
  const baselineFor = (key: keyof ReturnType<typeof windowMetrics>) => ({
    h24: prior24.map((bucket) => bucket.metrics[key]),
    d7: prior7d.map((bucket) => bucket.metrics[key]),
  });
  const mentionsSeries = baselineFor("mentions");
  const authorsSeries = baselineFor("uniqueAuthors");
  const engagementSeries = baselineFor("engagement");
  const organicSeries = baselineFor("organicShare");

  const baselines = {
    mentions15m: robustBaseline(windows.m15.mentions, mentionsSeries.h24, mentionsSeries.d7),
    uniqueAuthors15m: robustBaseline(windows.m15.uniqueAuthors, authorsSeries.h24, authorsSeries.d7),
    engagement15m: robustBaseline(windows.m15.engagement, engagementSeries.h24, engagementSeries.d7),
    organicShare15m: robustBaseline(windows.m15.organicShare, organicSeries.h24, organicSeries.d7),
  };

  const rawConc = concentration(h1Rows, nowMs, false);
  const weightedConc = concentration(h1Rows, nowMs, true);
  const profileRows = h1Rows.filter((row) => row.followers != null || row.firstSeenAt != null || row.botScore != null);
  const profileCoverage = h1Rows.length ? profileRows.length / h1Rows.length : 0;

  const normalized = h1Rows.map((row) => normalizedText(row.text)).filter(Boolean);
  const duplicateTextRatio = normalized.length ? 1 - new Set(normalized).size / normalized.length : 0;
  const linkKeys = h1Rows.map(linkKey).filter((value): value is string => Boolean(value));
  // A single shared link is not coordination evidence. Require at least 3 linked rows.
  const linkOverlapRatio = linkKeys.length >= 3 ? maxShare(linkKeys) : 0;
  const suspiciousShare = h1Rows.length ? h1Rows.filter((row) => row.isSuspicious || row.isBot).length / h1Rows.length : 0;
  const burstRatio = temporalBurstRatio(h1Rows, nowMs);
  const coordinationScore = clamp(
    duplicateTextRatio * 0.30
      + burstRatio * 0.20
      + linkOverlapRatio * 0.15
      + suspiciousShare * 0.20
      + (rawConc.top5 ?? 0) * 0.15,
  ) * 100;

  const baselineBuckets = Math.max(
    baselines.mentions15m.sampleBuckets,
    baselines.uniqueAuthors15m.sampleBuckets,
    baselines.engagement15m.sampleBuckets,
  );
  const fallbackMomentum = clamp(windows.m15.mentions / Math.max(1, windows.h1.mentions), 0, 1) * 100;
  const momentumCore = (scoreFromZ(baselines.mentions15m.robustZ, fallbackMomentum) * 0.55)
    + (scoreFromZ(baselines.uniqueAuthors15m.robustZ, fallbackMomentum) * 0.30)
    + (windows.m15.organicShare * 100 * 0.15);
  const organicMomentumValue = clamp(momentumCore / 100) * 100;

  const authorQualityByName = new Map<string, { quality: number; weight: number }>();
  for (const row of h1Rows) {
    const key = row.author.toLowerCase();
    const quality = accountQuality(row, nowMs);
    const weight = 1 + Math.log1p(engagement(row));
    const current = authorQualityByName.get(key) || { quality: 0, weight: 0 };
    current.quality += quality * weight;
    current.weight += weight;
    authorQualityByName.set(key, current);
  }
  const authorQualities = [...authorQualityByName.values()].map((row) => row.weight ? row.quality / row.weight : 0);
  const influencerCredibilityValue = authorQualities.length ? clamp(authorQualities.reduce((a, b) => a + b, 0) / authorQualities.length) * 100 : null;

  const recentBuckets = [0, 1, 2, 3].map((offset) => {
    const end = nowMs - offset * BUCKET_MS;
    return rows.filter((row) => {
      const ts = timestampOf(row);
      return ts != null && ts > end - BUCKET_MS && ts <= end;
    });
  });
  const occupied = recentBuckets.filter((bucket) => bucket.length > 0).length / 4;
  const authorBucketCount = new Map<string, number>();
  for (const bucket of recentBuckets) {
    for (const author of new Set(bucket.map((row) => row.author.toLowerCase()))) {
      authorBucketCount.set(author, (authorBucketCount.get(author) || 0) + 1);
    }
  }
  const persistentAuthors = [...authorBucketCount.values()].filter((count) => count >= 2).length;
  const persistence = authorBucketCount.size ? persistentAuthors / authorBucketCount.size : 0;
  const diversity = h1Rows.length ? clamp(windows.h1.uniqueAuthors / h1Rows.length) : 0;
  const narrativeDurabilityValue = clamp(occupied * 0.4 + persistence * 0.25 + diversity * 0.2 + (1 - duplicateTextRatio) * 0.15) * 100;

  const priceAbs = market.priceChange1h == null ? null : Math.abs(market.priceChange1h);
  const socialAnomaly = baselines.mentions15m.robustZ == null ? null : Math.abs(baselines.mentions15m.robustZ);
  const socialMarketConfirmationValue = priceAbs == null || socialAnomaly == null
    ? null
    : clamp((clamp(socialAnomaly / 3) * 0.6) + (clamp(priceAbs / 10) * 0.4)) * 100;

  const contradictions: TwitterContradictionV2[] = [];
  const mz = baselines.mentions15m.robustZ;
  const az = baselines.uniqueAuthors15m.robustZ;
  const ez = baselines.engagement15m.robustZ;
  if (mz != null && az != null && mz >= 2 && az <= 0) contradictions.push({ type: "volume_without_breadth", severity: clamp((mz - az) / 5), description: "Mention volume is anomalously high while independent-author breadth is flat or below baseline.", evidenceKeys: ["twitter_v2.baseline.mentions_15m_z", "twitter_v2.baseline.unique_authors_15m_z"] });
  if (mz != null && mz >= 2 && (rawConc.top5 ?? 0) >= 0.6) contradictions.push({ type: "concentrated_burst", severity: clamp(((rawConc.top5 ?? 0) - 0.5) * 2), description: "A social burst is concentrated in a small set of authors rather than broadly distributed.", evidenceKeys: ["twitter_v2.baseline.mentions_15m_z", "twitter_v2.concentration.raw_top5"] });
  if (organicMomentumValue >= 65 && priceAbs != null && priceAbs < 1) contradictions.push({ type: "social_without_market_confirmation", severity: clamp((organicMomentumValue - 60) / 40), description: "Social momentum is elevated while the 1h market move remains comparatively flat.", evidenceKeys: ["twitter_v2.score.organic_momentum", "twitter_v2.market.price_change_1h"] });
  if (coordinationScore >= 65 && windows.m15.organicShare < 0.6) contradictions.push({ type: "coordination_vs_organic", severity: clamp((coordinationScore - 55) / 45), description: "Coordination risk is elevated while the recent organic share is weak.", evidenceKeys: ["twitter_v2.score.coordination_risk", "twitter_v2.window.m15_organic_share"] });
  if (ez != null && az != null && ez >= 2 && az < 0) contradictions.push({ type: "engagement_without_breadth", severity: clamp((ez - az) / 5), description: "Engagement is spiking without a corresponding expansion in unique authors.", evidenceKeys: ["twitter_v2.baseline.engagement_15m_z", "twitter_v2.baseline.unique_authors_15m_z"] });
  const contradictionValue = clamp(contradictions.reduce((sum, row) => sum + row.severity * 35, 0) / 100) * 100;

  const latestFetchedAt = rows.length ? Math.max(...rows.map((row) => finite(row.fetchedAt, 0))) || null : null;
  const ageMs = latestFetchedAt == null ? null : Math.max(0, nowMs - latestFetchedAt);
  const timestampCoverage = rows.length ? rows.filter((row) => timestampOf(row) != null).length / rows.length : 0;
  const textCoverage = rows.length ? rows.filter((row) => row.text.trim().length > 0).length / rows.length : 0;
  const dataCompleteness = clamp(timestampCoverage * 0.4 + textCoverage * 0.3 + profileCoverage * 0.3);
  const sampleReliability = clamp(h1Rows.length / 30);
  const historicalCalibration = clamp(baselineBuckets / 24);
  const signalAgreement = clamp(1 - contradictionValue / 125);
  const freshness = ageMs == null ? 0 : clamp(Math.exp(-ageMs / (45 * MINUTE)));
  const confidenceValue = clamp(
    dataCompleteness * 0.24
      + sampleReliability * 0.20
      + historicalCalibration * 0.22
      + signalAgreement * 0.18
      + freshness * 0.16,
  );
  const penalties: string[] = [];
  if (baselineBuckets < 12) penalties.push("insufficient_baseline_history");
  if (profileCoverage < 0.5) penalties.push("low_author_profile_coverage");
  if (contradictionValue >= 50) penalties.push("high_internal_contradiction");
  if (market.priceChange1h == null) penalties.push("market_confirmation_unavailable");
  if (market.stale) penalties.push("market_context_stale");

  const rules: string[] = [];
  let stage: TwitterIntelligenceV2["lifecycle"]["stage"] = "uncertain";
  if (h1Rows.length >= 5) {
    if (mz != null && az != null && mz >= 2 && az >= 1 && coordinationScore < 60) {
      stage = "acceleration"; rules.push("mentions_z>=2", "unique_authors_z>=1", "coordination<60");
    } else if (mz != null && mz >= 2 && (az ?? 0) <= 0.25) {
      stage = "saturation"; rules.push("mentions_z>=2", "breadth_not_expanding");
    } else if (occupied >= 0.75 && diversity >= 0.55 && (rawConc.top5 ?? 1) < 0.55) {
      stage = "broad_discovery"; rules.push("3+_recent_buckets_active", "high_author_diversity", "top5_concentration<55%");
    } else if (recentBuckets[0].length >= 3 && recentBuckets[1].length <= Math.max(1, recentBuckets[0].length / 2)) {
      stage = "ignition"; rules.push("recent_bucket_acceleration");
    } else if (recentBuckets[0].length <= Math.max(1, recentBuckets[1].length * 0.5) && recentBuckets[1].length >= 5) {
      stage = "exhaustion"; rules.push("current_bucket_drop>=50%", "previous_bucket_active");
    } else if (windows.m15.mentions === 0 && windows.h1.mentions > 0) {
      stage = "decay"; rules.push("no_recent_mentions", "prior_hour_activity_present");
    }
  }
  const lifecycleConfidence = clamp((sampleReliability * 0.45) + (historicalCalibration * 0.25) + (signalAgreement * 0.30));

  const scoreConfidence = featureConfidence(confidenceValue, h1Rows.length, baselineBuckets);
  const scores = {
    organicMomentum: { value: organicMomentumValue, confidence: scoreConfidence, evidenceKeys: ["twitter_v2.baseline.mentions_15m_z", "twitter_v2.baseline.unique_authors_15m_z", "twitter_v2.window.m15_organic_share"], note: "Activity/breadth anomaly against robust historical baselines; not price direction." },
    influencerCredibility: { value: influencerCredibilityValue, confidence: clamp(scoreConfidence * profileCoverage * 0.8), evidenceKeys: ["twitter_v2.author.profile_coverage", "twitter_v2.concentration.weighted_top5"], note: "Author-quality proxy only. Historical early-call hit-rate is intentionally not claimed in v10.27." },
    narrativeDurability: { value: narrativeDurabilityValue, confidence: clamp(scoreConfidence * Math.min(1, h1Rows.length / 12)), evidenceKeys: ["twitter_v2.narrative.active_bucket_share", "twitter_v2.narrative.persistent_author_share", "twitter_v2.coordination.duplicate_text_ratio"], note: "Deterministic persistence/diversity proxy; semantic clustering is deferred." },
    coordinationRisk: { value: coordinationScore, confidence: clamp(scoreConfidence * Math.min(1, h1Rows.length / 10)), evidenceKeys: ["twitter_v2.coordination.duplicate_text_ratio", "twitter_v2.coordination.temporal_burst_ratio", "twitter_v2.coordination.link_overlap_ratio", "twitter_v2.coordination.suspicious_share", "twitter_v2.concentration.raw_top5"], note: "Ensemble heuristic, not proof of coordinated behavior." },
    socialMarketConfirmation: { value: socialMarketConfirmationValue, confidence: socialMarketConfirmationValue == null ? 0 : clamp(scoreConfidence * (market.stale ? 0.5 : 0.85)), evidenceKeys: ["twitter_v2.baseline.mentions_15m_z", "twitter_v2.market.price_change_1h"], note: "Measures co-occurrence of social anomaly and market movement; does not establish causality." },
    contradiction: { value: contradictionValue, confidence: clamp(scoreConfidence * Math.min(1, contradictions.length / 2 + 0.5)), evidenceKeys: [...new Set(contradictions.flatMap((row) => row.evidenceKeys))].slice(0, 12), note: "Higher means more internally conflicting deterministic evidence." },
  } satisfies TwitterIntelligenceV2["scores"];

  const unknowns: string[] = [];
  if (baselines.mentions15m.baselineWindow === "insufficient") unknowns.push("robust_baseline_insufficient");
  if (market.priceChange1h == null) unknowns.push("market_price_1h_missing");
  if (profileCoverage < 0.5) unknowns.push("author_profile_coverage_low");
  unknowns.push("historical_influencer_outcomes_not_in_v10_27");
  unknowns.push("semantic_coordination_embeddings_not_in_v10_27");

  const contentSeed = {
    schemaVersion: TWITTER_INTELLIGENCE_V2_SCHEMA_VERSION,
    engineVersion: TWITTER_INTELLIGENCE_V2_ENGINE_VERSION,
    mint: args.mint,
    sourceMaxFetchedAt: latestFetchedAt,
    windows,
    baselines,
    concentration: { rawConc, weightedConc, profileCoverage },
    coordinationScore,
    contradictionValue,
    stage,
    market,
  };

  const result: TwitterIntelligenceV2 = {
    snapshotId: `twitter-v2-${hashSnapshot(contentSeed)}`,
    schemaVersion: TWITTER_INTELLIGENCE_V2_SCHEMA_VERSION,
    engineVersion: TWITTER_INTELLIGENCE_V2_ENGINE_VERSION,
    mint: args.mint,
    createdAt: new Date(nowMs).toISOString(),
    sourceMaxFetchedAt: latestFetchedAt,
    windows,
    baselines,
    concentration: {
      rawTop1: rawConc.top1,
      rawTop5: rawConc.top5,
      rawTop10: rawConc.top10,
      weightedTop1: weightedConc.top1,
      weightedTop5: weightedConc.top5,
      weightedTop10: weightedConc.top10,
      profileCoverage,
    },
    coordination: { duplicateTextRatio, temporalBurstRatio: burstRatio, linkOverlapRatio, suspiciousShare, score: coordinationScore },
    narrative: { activeBucketShare: occupied, persistentAuthorShare: persistence, diversity, novelty: 1 - duplicateTextRatio },
    market,
    lifecycle: { stage, confidence: lifecycleConfidence, rules },
    scores,
    contradictions,
    confidence: {
      value: confidenceValue,
      components: { dataCompleteness, sampleReliability, historicalCalibration, signalAgreement, freshness },
      horizons: {
        m15: confidenceValue,
        h1: clamp(confidenceValue * 0.94),
        h4: clamp(confidenceValue * 0.80),
        h24: clamp(confidenceValue * 0.65),
      },
      penalties,
    },
    freshness: { latestFetchedAt, ageMs },
    unknowns,
    sample: { totalRows7d: d7Rows.length, current15m: m15Rows.length, current1h: h1Rows.length, baselineBuckets },
  };
  validateTwitterIntelligenceV2(result);
  return result;
}

export function buildTwitterIntelligenceV2FromSnapshot(args: {
  mint: string;
  rows: TwitterHistoryRowV2[];
  snapshotFeatures: Array<{ key?: string; label?: string; numericValue?: number | null; missing?: boolean }>;
  marketStale?: boolean;
  nowMs?: number;
}) {
  const market = extractMarketContextFromFeatures(args.snapshotFeatures);
  if (args.marketStale != null) market.stale = Boolean(args.marketStale);
  return buildTwitterIntelligenceV2({
    mint: args.mint,
    rows: args.rows,
    nowMs: args.nowMs,
    market,
  });
}

export function twitterIntelligenceV2FeatureRows(intelligence: TwitterIntelligenceV2) {
  const rows: Array<{ key: string; label: string; value: string | number | null; numericValue: number | null; confidence: number; missing: boolean; note: string }> = [];
  const add = (key: string, label: string, value: number | string | null, confidence: number, note: string) => rows.push({
    key,
    label,
    value,
    numericValue: typeof value === "number" && Number.isFinite(value) ? value : null,
    confidence: clamp(confidence),
    missing: value == null,
    note,
  });
  const c = intelligence.confidence.value;
  add("twitter_v2.baseline.mentions_15m_z", "Twitter V2 mentions 15m robust z", intelligence.baselines.mentions15m.robustZ, c, `Baseline=${intelligence.baselines.mentions15m.baselineWindow}; buckets=${intelligence.baselines.mentions15m.sampleBuckets}.`);
  add("twitter_v2.baseline.mentions_15m_percentile", "Twitter V2 mentions 15m percentile", intelligence.baselines.mentions15m.percentile, c, "Percentile against reusable non-empty historical 15m buckets; missing intervals are not silently treated as zero collection.");
  add("twitter_v2.baseline.unique_authors_15m_z", "Twitter V2 unique authors 15m robust z", intelligence.baselines.uniqueAuthors15m.robustZ, c, `Baseline=${intelligence.baselines.uniqueAuthors15m.baselineWindow}; buckets=${intelligence.baselines.uniqueAuthors15m.sampleBuckets}.`);
  add("twitter_v2.baseline.unique_authors_15m_percentile", "Twitter V2 unique authors 15m percentile", intelligence.baselines.uniqueAuthors15m.percentile, c, "Percentile against reusable non-empty historical 15m buckets.");
  add("twitter_v2.baseline.engagement_15m_z", "Twitter V2 engagement 15m robust z", intelligence.baselines.engagement15m.robustZ, c, "Robust median/MAD normalization; missing when history is insufficient.");
  add("twitter_v2.window.m15_organic_share", "Twitter V2 organic share 15m", intelligence.windows.m15.organicShare, c, "Share of recent rows not flagged suspicious/bot by deterministic collectors.");
  add("twitter_v2.concentration.raw_top1", "Twitter V2 raw top-1 author concentration", intelligence.concentration.rawTop1, c, "Unweighted share of 1h mentions produced by the most active author.");
  add("twitter_v2.concentration.raw_top5", "Twitter V2 raw top-5 author concentration", intelligence.concentration.rawTop5, c, "Unweighted share of 1h mentions produced by the five most active authors.");
  add("twitter_v2.concentration.raw_top10", "Twitter V2 raw top-10 author concentration", intelligence.concentration.rawTop10, c, "Unweighted share of 1h mentions produced by the ten most active authors.");
  add("twitter_v2.concentration.weighted_top1", "Twitter V2 quality-weighted top-1 concentration", intelligence.concentration.weightedTop1, c * intelligence.concentration.profileCoverage, "Quality weighting uses available follower/activity/bot fields and POTAPoff observation tenure; it is not historical hit-rate or X account age.");
  add("twitter_v2.concentration.weighted_top5", "Twitter V2 quality-weighted top-5 concentration", intelligence.concentration.weightedTop5, c * intelligence.concentration.profileCoverage, "Quality weighting uses available follower/activity/bot fields and POTAPoff observation tenure; it is not historical hit-rate or X account age.");
  add("twitter_v2.concentration.weighted_top10", "Twitter V2 quality-weighted top-10 concentration", intelligence.concentration.weightedTop10, c * intelligence.concentration.profileCoverage, "Quality weighting uses available follower/activity/bot fields and POTAPoff observation tenure; it is not historical hit-rate or X account age.");
  add("twitter_v2.author.profile_coverage", "Twitter V2 author profile coverage", intelligence.concentration.profileCoverage, c, "Fraction of 1h tweet rows with reusable author profile fields.");
  add("twitter_v2.coordination.duplicate_text_ratio", "Twitter V2 duplicate-text ratio", intelligence.coordination.duplicateTextRatio, c, "Normalized-text duplication signal; semantic paraphrase detection is not included yet.");
  add("twitter_v2.coordination.temporal_burst_ratio", "Twitter V2 temporal burst ratio", intelligence.coordination.temporalBurstRatio, c, "Largest 2-minute event cluster divided by 1h sample size.");
  add("twitter_v2.coordination.link_overlap_ratio", "Twitter V2 link overlap ratio", intelligence.coordination.linkOverlapRatio, c, "Dominant normalized link share among rows that contain links.");
  add("twitter_v2.coordination.suspicious_share", "Twitter V2 suspicious author/post share", intelligence.coordination.suspiciousShare, c, "Collector-level suspicious/bot flags; not proof of manipulation.");
  add("twitter_v2.market.price_change_1h", "Twitter V2 market price change 1h", intelligence.market.priceChange1h, intelligence.market.stale ? c * 0.4 : c * 0.8, "Canonical 1h market change copied into the V2 evidence namespace for contradiction grounding; not causal evidence.");
  add("twitter_v2.market.volume_1h", "Twitter V2 market volume 1h", intelligence.market.volume1h, intelligence.market.stale ? c * 0.4 : c * 0.8, "Canonical market volume context; stale market data lowers confidence.");
  add("twitter_v2.narrative.active_bucket_share", "Twitter V2 narrative active-bucket share", intelligence.narrative.activeBucketShare, intelligence.scores.narrativeDurability.confidence, "Share of the four most recent 15m buckets containing observed X activity.");
  add("twitter_v2.narrative.persistent_author_share", "Twitter V2 persistent-author share", intelligence.narrative.persistentAuthorShare, intelligence.scores.narrativeDurability.confidence, "Share of observed authors present in at least two recent 15m buckets.");
  add("twitter_v2.narrative.diversity", "Twitter V2 author diversity", intelligence.narrative.diversity, intelligence.scores.narrativeDurability.confidence, "Unique-author share in the recent 1h window.");
  add("twitter_v2.narrative.novelty", "Twitter V2 text novelty proxy", intelligence.narrative.novelty, intelligence.scores.narrativeDurability.confidence, "One minus exact normalized-text duplicate ratio; semantic paraphrase novelty is deferred.");
  add("twitter_v2.score.organic_momentum", "Organic Momentum Score", intelligence.scores.organicMomentum.value, intelligence.scores.organicMomentum.confidence, intelligence.scores.organicMomentum.note);
  add("twitter_v2.score.influencer_credibility", "Influencer Credibility Score", intelligence.scores.influencerCredibility.value, intelligence.scores.influencerCredibility.confidence, intelligence.scores.influencerCredibility.note);
  add("twitter_v2.score.narrative_durability", "Narrative Durability Score", intelligence.scores.narrativeDurability.value, intelligence.scores.narrativeDurability.confidence, intelligence.scores.narrativeDurability.note);
  add("twitter_v2.score.coordination_risk", "Coordination Risk Score", intelligence.scores.coordinationRisk.value, intelligence.scores.coordinationRisk.confidence, intelligence.scores.coordinationRisk.note);
  add("twitter_v2.score.social_market_confirmation", "Social to Market Confirmation Score", intelligence.scores.socialMarketConfirmation.value, intelligence.scores.socialMarketConfirmation.confidence, intelligence.scores.socialMarketConfirmation.note);
  add("twitter_v2.score.contradiction", "Contradiction Score", intelligence.scores.contradiction.value, intelligence.scores.contradiction.confidence, intelligence.scores.contradiction.note);
  add("twitter_v2.confidence", "Twitter V2 deterministic confidence", intelligence.confidence.value, intelligence.confidence.value, `Deterministic confidence. Penalties=${intelligence.confidence.penalties.join(",") || "none"}. LLM may not raise this value.`);
  add("twitter_v2.confidence.data_completeness", "Twitter V2 data completeness", intelligence.confidence.components.dataCompleteness, c, "Deterministic confidence component.");
  add("twitter_v2.confidence.sample_reliability", "Twitter V2 sample reliability", intelligence.confidence.components.sampleReliability, c, "Deterministic confidence component.");
  add("twitter_v2.confidence.historical_calibration", "Twitter V2 historical calibration coverage", intelligence.confidence.components.historicalCalibration, c, "Deterministic confidence component derived from reusable baseline buckets.");
  add("twitter_v2.confidence.signal_agreement", "Twitter V2 signal agreement", intelligence.confidence.components.signalAgreement, c, "Deterministic confidence component reduced by contradictions.");
  add("twitter_v2.confidence.freshness", "Twitter V2 freshness confidence", intelligence.confidence.components.freshness, c, "Deterministic confidence component based on latest persisted X fetch.");
  add("twitter_v2.confidence.m15", "Twitter V2 confidence 15m", intelligence.confidence.horizons.m15, c, "Horizon-specific deterministic analytical confidence.");
  add("twitter_v2.confidence.h1", "Twitter V2 confidence 1h", intelligence.confidence.horizons.h1, c, "Horizon-specific deterministic analytical confidence.");
  add("twitter_v2.confidence.h4", "Twitter V2 confidence 4h", intelligence.confidence.horizons.h4, c, "Horizon-specific deterministic analytical confidence.");
  add("twitter_v2.confidence.h24", "Twitter V2 confidence 24h", intelligence.confidence.horizons.h24, c, "Horizon-specific deterministic analytical confidence.");
  add("twitter_v2.lifecycle.stage", "Twitter V2 deterministic lifecycle stage", intelligence.lifecycle.stage, intelligence.lifecycle.confidence, `Rule-assigned stage. Rules=${intelligence.lifecycle.rules.join("|") || "none"}. LLM must not override.`);
  add("twitter_v2.contradictions.count", "Twitter V2 contradiction count", intelligence.contradictions.length, intelligence.scores.contradiction.confidence, intelligence.contradictions.map((row) => `${row.type}:${row.description}`).join(" | ").slice(0, 900) || "No deterministic contradictions triggered.");
  return rows;
}

export function validateTwitterIntelligenceV2(value: TwitterIntelligenceV2) {
  if (!value || value.schemaVersion !== TWITTER_INTELLIGENCE_V2_SCHEMA_VERSION) throw new Error("twitter_v2_invalid_schema_version");
  if (!value.snapshotId.startsWith("twitter-v2-")) throw new Error("twitter_v2_invalid_snapshot_id");
  if (!value.mint) throw new Error("twitter_v2_missing_mint");
  const bounded = [
    value.confidence.value,
    ...Object.values(value.confidence.components),
    ...Object.values(value.confidence.horizons),
    value.concentration.profileCoverage,
    value.coordination.duplicateTextRatio,
    value.coordination.temporalBurstRatio,
    value.coordination.linkOverlapRatio,
    value.coordination.suspiciousShare,
  ];
  if (bounded.some((item) => !Number.isFinite(item) || item < 0 || item > 1)) throw new Error("twitter_v2_probability_out_of_bounds");
  for (const score of Object.values(value.scores)) {
    if (score.value != null && (!Number.isFinite(score.value) || score.value < 0 || score.value > 100)) throw new Error("twitter_v2_score_out_of_bounds");
    if (!Number.isFinite(score.confidence) || score.confidence < 0 || score.confidence > 1) throw new Error("twitter_v2_score_confidence_out_of_bounds");
  }
  return value;
}
