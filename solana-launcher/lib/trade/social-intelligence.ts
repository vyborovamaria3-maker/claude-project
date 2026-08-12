export const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const IMPULSE_WINDOW_MS = 5 * 60_000;
export const IMPULSE_THRESHOLD_PCT = 10;
const HOUR_MS = 60 * 60_000;

export type Lookback = "1" | "6" | "24" | "72" | "168" | "720" | "all";

export type SocialOptions = {
  symbol: string;
  lookback: Lookback;
  xLimit: number;
  xVerifiedOnly: boolean;
  xExcludeSuspicious: boolean;
  tgLimit: number;
  tgMinChannelScore: number;
  tgExplicitCallsOnly: boolean;
};

export type TimelineItem = {
  platform: string;
  event_type?: string;
  source_handle: string | null;
  source_name: string | null;
  source_url: string | null;
  text: string;
  occurred_at: string;
  metrics: Record<string, unknown> | null;
};

export type Tweet = {
  id: string;
  text: string;
  author: string;
  likes: number;
  retweets: number;
  views: number;
  timestamp: number | null;
  isSuspicious: boolean;
};

export type Shiller = {
  handle: string;
  tweets: number;
  totalEngagement: number;
  isBot: boolean;
  followers: number | null;
  postsCount: number | null;
  isVerified: boolean;
};

export type TwitterStats = {
  symbol: string;
  totalTweets: number;
  totalViews: number;
  totalLikes: number;
  totalRetweets: number;
  uniqueMentioners: number;
  botRiskScore: number;
  anomalyCount: number;
  topTweets: Tweet[];
  shillers: Shiller[];
  collectionTruncated?: boolean;
  sampleLimit?: number;
  aggregated: {
    totalEngagement: number;
    engagementRate: number;
    verifiedAuthors: number;
    botRatio: number;
  };
};

export type SocialTimeline = {
  mentions: number;
  platforms: Record<string, number>;
  origin: TimelineItem | null;
  timeline: TimelineItem[];
  meta?: {
    matchedBeforeLimit?: number;
    truncated?: boolean;
  };
};

export type Channel = {
  username: string | null;
  title: string;
  score: number;
  win_rate: number;
  rug_rate: number;
  calls_count?: number;
  evaluated_calls?: number;
};

export type Market = {
  pair?: {
    name?: string;
    createdAt?: number | null;
    changeH1?: number | null;
    change24h?: number | null;
    volumeH1?: number | null;
    volumeH24?: number | null;
    liquidityUsd?: number | null;
  };
};

export type ChainWallet = {
  address: string;
  buys?: number;
  sells?: number;
  volumeSol?: number;
  pnlSol?: number;
  pnlPercent?: number;
  solBalance?: number;
  isFresh?: boolean;
  isSmart?: boolean;
  isWashTrader?: boolean;
  bundleId?: string | number | null;
  relatedCount?: number;
  firstSeen?: number | null;
};

export type ChainBundle = {
  id: string | number;
  size?: number;
  totalVolumeSol?: number;
  wallets?: string[];
};

export type ChainAnalysis = {
  trades?: Array<{ ts: number; p: number; w?: string; sig?: string }>;
  wallets?: ChainWallet[];
  bundles?: ChainBundle[];
  truncated?: boolean;
  summary?: {
    totalRawTrades?: number;
    totalTrades?: number;
    uniqueWallets?: number;
    periodStart?: number | null;
    periodEnd?: number | null;
  };
};

export type AiSignal = {
  severity?: string;
  confidence?: number;
};

export type AiResult = {
  summary?: string;
  dominantIntent?: string;
  sentiment?: { label?: string; score?: number; confidence?: number };
  coordinationSignals?: AiSignal[];
  risks?: AiSignal[];
  claims?: unknown[];
  entities?: unknown[];
  relationships?: unknown[];
  reasoningSummary?: string[];
  overallConfidence?: number;
  campaignHypothesis?: {
    label?: string;
    confidence?: number;
    narrative?: string;
    likelyOriginators?: string[];
    amplifiers?: string[];
  };
};

export type AiEnvelope = {
  agent?: string;
  available?: boolean;
  provider?: string;
  model?: string;
  latencyMs?: number;
  cache?: string;
  error?: string;
  result?: AiResult;
};

export type Metric = { label: string; value: string; note?: string };

export type PriceSocial = {
  socialSpikeTime: number | null;
  reaction5: number | null;
  reaction15: number | null;
  reaction60: number | null;
  maxUpside: number | null;
  maxDrawdown: number | null;
  impulseTime: number | null;
  impulseChange: number | null;
  leadLagMinutes: number | null;
  leadDirection: string;
  leadLagConfidence: number | null;
  tradeCount: number;
};

export type DerivedSocial = {
  groups: Array<{ title: string; rows: Metric[] }>;
  xScore: number;
  tgScore: number;
  organic: number;
  manipulation: number;
  socialRisk: number;
  early: number;
  alpha: number;
  socialScore: number;
  price: PriceSocial;
};

type TradePoint = { time: number; price: number };
type WeightedComponent = { value: number | null; weight: number };

export const DEFAULT_SOCIAL_OPTIONS: SocialOptions = {
  symbol: "",
  lookback: "24",
  xLimit: 40,
  xVerifiedOnly: false,
  xExcludeSuspicious: true,
  tgLimit: 200,
  tgMinChannelScore: 0,
  tgExplicitCallsOnly: false,
};

export function numberOr(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function hasNumber(value: unknown) {
  return value !== null
    && value !== undefined
    && value !== ""
    && Number.isFinite(Number(value));
}

export function compact(value: unknown) {
  return hasNumber(value)
    ? new Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(Number(value))
    : "—";
}

export function pct(value: unknown) {
  return hasNumber(value) ? `${Number(value).toFixed(1)}%` : "—";
}

export function signedPct(value: unknown) {
  return hasNumber(value)
    ? `${Number(value) >= 0 ? "+" : ""}${Number(value).toFixed(1)}%`
    : "—";
}

export function score(value: unknown) {
  return hasNumber(value) ? `${Math.round(Number(value))}/100` : "—";
}

export function money(value: unknown) {
  return hasNumber(value) ? `$${compact(value)}` : "—";
}

export function toTimestamp(value: unknown) {
  if (value == null || value === "") return null;
  let parsed = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(parsed)) return null;
  if (parsed < 1e12) parsed *= 1000;
  return parsed;
}

export function ago(value: unknown, now = Date.now()) {
  const timestamp = toTimestamp(value);
  if (timestamp == null) return "—";
  const minutes = Math.max(0, Math.round((now - timestamp) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 2880) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

export function upsertWarning(warnings: string[], message: string) {
  const key = message.split(":", 1)[0];
  return [
    ...warnings.filter((item) => item.split(":", 1)[0] !== key),
    message,
  ];
}

const average = (values: number[]) => (
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
);

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

const normalizeText = (value: string) => value
  .toLowerCase()
  .replace(/https?:\/\/\S+/g, " ")
  .replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, " ")
  .replace(/[^\p{L}\p{N}]+/gu, " ")
  .trim()
  .slice(0, 220);

const normalizeRatePct = (value: unknown) => {
  if (!hasNumber(value)) return null;
  const parsed = Number(value);
  return clamp(Math.abs(parsed) <= 1 ? parsed * 100 : parsed);
};

const growthPct = (current: number, previous: number) => (
  previous > 0 ? ((current - previous) / previous) * 100 : null
);

const metric = (label: string, value: string, note?: string): Metric => ({
  label,
  value,
  ...(note ? { note } : {}),
});

function weightedScore(components: WeightedComponent[], coveragePenalty = 0) {
  const totalWeight = components.reduce((sum, item) => sum + item.weight, 0);
  const available = components.filter(
    (item): item is { value: number; weight: number } => item.value != null,
  );
  const availableWeight = available.reduce((sum, item) => sum + item.weight, 0);
  if (!availableWeight || !totalWeight) return { score: 0, coverage: 0 };
  const raw = available.reduce(
    (sum, item) => sum + clamp(item.value) * item.weight,
    0,
  ) / availableWeight;
  const coverage = availableWeight / totalWeight;
  const penaltyMultiplier = 1 - coveragePenalty * (1 - coverage);
  return { score: clamp(raw * penaltyMultiplier), coverage };
}

function sentiment(texts: string[]) {
  const positive = /\b(bull|bullish|buy|gem|moon|pump|breakout|alpha|early|strong|ape|send|upside|good|great|лонг|покуп|ракета|рост|гем)\b|🚀|🔥|📈|💎/i;
  const negative = /\b(rug|scam|dump|sell|exit|dead|avoid|warning|bear|rekt|скам|раг|слив|продаж|паден)\b|⚠|📉|☠/i;
  let pos = 0;
  let neg = 0;
  let neutral = 0;
  for (const text of texts) {
    const p = positive.test(text);
    const n = negative.test(text);
    if (p && !n) pos += 1;
    else if (n && !p) neg += 1;
    else neutral += 1;
  }
  const total = pos + neg + neutral;
  return total
    ? {
        label: pos / total > 0.52 ? "BULLISH" : neg / total > 0.38 ? "BEARISH" : "MIXED",
        p: (pos / total) * 100,
        n: (neg / total) * 100,
        u: (neutral / total) * 100,
      }
    : { label: "—", p: 0, n: 0, u: 0 };
}

function sentimentDelta(rows: Array<{ time: number | null; text: string }>) {
  const sorted = rows
    .filter((row): row is { time: number; text: string } => row.time != null)
    .sort((a, b) => a.time - b.time);
  if (sorted.length < 4) return null;
  const middle = Math.floor(sorted.length / 2);
  const earlier = sentiment(sorted.slice(0, middle).map((row) => row.text));
  const later = sentiment(sorted.slice(middle).map((row) => row.text));
  return later.p - earlier.p;
}

function windowStats<T>(
  rows: T[],
  timeOf: (row: T) => number | null,
  keyOf: (row: T) => unknown,
  now: number,
) {
  const counts = { m5: 0, m15: 0, h1: 0, h6: 0, h24: 0 };
  const unique6 = new Set<string>();
  const uniquePrev6 = new Set<string>();
  const unique24 = new Set<string>();
  for (const row of rows) {
    const time = timeOf(row);
    if (time == null) continue;
    const age = now - time;
    if (age < 0) continue;
    if (age <= 5 * 60_000) counts.m5 += 1;
    if (age <= 15 * 60_000) counts.m15 += 1;
    if (age <= HOUR_MS) counts.h1 += 1;
    if (age <= 6 * HOUR_MS) counts.h6 += 1;
    if (age <= 24 * HOUR_MS) counts.h24 += 1;
    const key = keyOf(row);
    if (!key) continue;
    const normalized = String(key).toLowerCase();
    if (age <= 6 * HOUR_MS) unique6.add(normalized);
    else if (age <= 12 * HOUR_MS) uniquePrev6.add(normalized);
    if (age <= 24 * HOUR_MS) unique24.add(normalized);
  }
  return {
    ...counts,
    unique6: unique6.size,
    uniquePrev6: uniquePrev6.size,
    unique24: unique24.size,
  };
}

function accelerationScore(window: { m5: number; m15: number }) {
  if (!window.m15) return 0;
  const recentRate = window.m5 / 5;
  const fifteenMinuteRate = window.m15 / 15;
  return clamp((recentRate / Math.max(fifteenMinuteRate, 1e-9)) * 50);
}

function densestWindow(times: number[], windowMs = 5 * 60_000) {
  const sorted = [...times].sort((a, b) => a - b);
  if (!sorted.length) return { time: null as number | null, count: 0 };
  let bestStart = 0;
  let bestEnd = 0;
  let end = 0;
  for (let start = 0; start < sorted.length; start += 1) {
    if (end < start) end = start;
    while (
      end + 1 < sorted.length
      && sorted[end + 1] - sorted[start] <= windowMs
    ) {
      end += 1;
    }
    if (end - start > bestEnd - bestStart) {
      bestStart = start;
      bestEnd = end;
    }
  }
  const count = bestEnd - bestStart + 1;
  return {
    time: sorted[Math.floor((bestStart + bestEnd) / 2)],
    count,
  };
}

function lowerBound(trades: TradePoint[], target: number) {
  let low = 0;
  let high = trades.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (trades[middle].time < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function priceAtOrBefore(trades: TradePoint[], target: number, toleranceMs: number) {
  const index = lowerBound(trades, target);
  const candidate = index < trades.length && trades[index].time === target
    ? trades[index]
    : trades[index - 1];
  return candidate && target - candidate.time <= toleranceMs ? candidate : null;
}

function priceAtOrAfter(trades: TradePoint[], target: number, toleranceMs: number) {
  const candidate = trades[lowerBound(trades, target)];
  return candidate && candidate.time - target <= toleranceMs ? candidate : null;
}

function priceChange(a: TradePoint | null, b: TradePoint | null) {
  return a && b && a.price > 0 ? ((b.price - a.price) / a.price) * 100 : null;
}

function findPriceImpulse(trades: TradePoint[], socialTime: number | null) {
  let best: { time: number; change: number } | null = null;
  for (const trade of trades) {
    if (socialTime != null && Math.abs(trade.time - socialTime) > 6 * HOUR_MS) continue;
    const base = priceAtOrBefore(
      trades,
      trade.time - IMPULSE_WINDOW_MS,
      IMPULSE_WINDOW_MS,
    );
    if (!base || base.price <= 0) continue;
    const change = ((trade.price - base.price) / base.price) * 100;
    if (Math.abs(change) < IMPULSE_THRESHOLD_PCT) continue;
    if (
      !best
      || socialTime == null
      || Math.abs(trade.time - socialTime) < Math.abs(best.time - socialTime)
    ) {
      best = { time: trade.time, change };
    }
  }
  return best;
}

function normalizeSource(value: string | null | undefined) {
  return String(value || "").trim().replace(/^@/, "").toLowerCase();
}

function severityValue(signal: AiSignal) {
  const severity = String(signal.severity || "").toLowerCase();
  const base = {
    info: 10,
    low: 25,
    medium: 50,
    high: 80,
    critical: 100,
  }[severity] ?? 0;
  const confidence = hasNumber(signal.confidence)
    ? clamp(Number(signal.confidence) * 100) / 100
    : 0.7;
  return base * confidence;
}

function aiSignalScore(signals: AiSignal[] | undefined) {
  if (!signals?.length) return 0;
  const values = signals.map(severityValue);
  const averageSeverity = average(values);
  const countPressure = Math.min(25, Math.max(0, signals.length - 1) * 4);
  return clamp(averageSeverity + countPressure);
}

function weightedChannelRate(
  channels: Channel[],
  field: "win_rate" | "rug_rate",
) {
  const eligible = channels
    .map((channel) => ({
      value: normalizeRatePct(channel[field]),
      weight: Math.max(0, numberOr(channel.evaluated_calls, 0)),
    }))
    .filter((row): row is { value: number; weight: number } => row.value != null && row.weight > 0);
  if (eligible.length) {
    const weight = eligible.reduce((sum, row) => sum + row.weight, 0);
    return eligible.reduce((sum, row) => sum + row.value * row.weight, 0) / weight;
  }
  const fallback = channels
    .map((channel) => normalizeRatePct(channel[field]))
    .filter((value): value is number => value != null);
  return fallback.length ? average(fallback) : null;
}

export function deriveSocialMetrics(
  x: TwitterStats | null,
  tg: SocialTimeline | null,
  market: Market | null,
  chain: ChainAnalysis | null,
  ai: AiEnvelope | null,
  channels: Channel[],
  options: SocialOptions,
): DerivedSocial {
  const now = Date.now();
  const tweets = x?.topTweets || [];
  const telegramItems = (tg?.timeline || []).filter(
    (item) => !item.platform || item.platform.toLowerCase() === "telegram",
  );
  const xAvailable = x != null;
  const tgAvailable = tg != null;
  const aiResult = ai?.result;

  const finiteX = tweets
    .map((tweet) => toTimestamp(tweet.timestamp))
    .filter((value): value is number => value != null);
  const finiteTg = telegramItems
    .map((item) => toTimestamp(item.occurred_at))
    .filter((value): value is number => value != null);

  const firstX = finiteX.length ? Math.min(...finiteX) : null;
  const firstTg = finiteTg.length ? Math.min(...finiteTg) : null;
  const both = firstX != null && firstTg != null;

  const requestedHours = Math.max(
    1,
    options.lookback === "all" ? 720 : Number(options.lookback),
  );
  const xMentions = x?.totalTweets || 0;
  const tgMentions = tg?.platforms?.telegram ?? telegramItems.length;
  const xVelocity = xAvailable ? xMentions / requestedHours : 0;
  const tgVelocity = tgAvailable ? tgMentions / requestedHours : 0;

  const xWindow = windowStats(
    tweets,
    (tweet) => toTimestamp(tweet.timestamp),
    (tweet) => tweet.author,
    now,
  );
  const tgWindow = windowStats(
    telegramItems,
    (item) => toTimestamp(item.occurred_at),
    (item) => item.source_handle || item.source_name,
    now,
  );
  const xAcceleration = xAvailable ? accelerationScore(xWindow) : 0;
  const tgAcceleration = tgAvailable ? accelerationScore(tgWindow) : 0;

  const xSentiment = sentiment(tweets.map((tweet) => tweet.text));
  const tgSentiment = sentiment(telegramItems.map((item) => item.text));
  const xSentimentDelta = sentimentDelta(
    tweets.map((tweet) => ({ time: toTimestamp(tweet.timestamp), text: tweet.text })),
  );
  const tgSentimentDelta = sentimentDelta(
    telegramItems.map((item) => ({
      time: toTimestamp(item.occurred_at),
      text: item.text,
    })),
  );

  const authorRatio = xMentions > 0
    ? clamp(((x?.uniqueMentioners || 0) / xMentions) * 100)
    : 0;
  const verifiedRatio = x?.uniqueMentioners
    ? clamp(((x.aggregated.verifiedAuthors || 0) / x.uniqueMentioners) * 100)
    : 0;
  const botRatio = normalizeRatePct(x?.aggregated.botRatio) ?? 0;
  const botRisk = xAvailable ? clamp(x?.botRiskScore || 0) : 0;
  const shillers = x?.shillers || [];
  const knownFollowers = shillers
    .map((account) => account.followers)
    .filter((value): value is number => value != null && value >= 0);
  const followerScale = knownFollowers.length
    ? clamp(Math.log10(median(knownFollowers) + 1) * 18)
    : null;
  const botCleanliness = xMentions > 0 ? 100 - botRisk : 0;
  const followerQuality = xAvailable && xMentions > 0
    ? weightedScore([
        { value: botCleanliness, weight: 0.45 },
        { value: x?.uniqueMentioners ? verifiedRatio : null, weight: 0.25 },
        { value: followerScale, weight: 0.30 },
      ], 0.2).score
    : 0;

  const reach = shillers.reduce(
    (sum, account) => sum + (account.followers || 0),
    0,
  );
  const influencers = shillers.filter(
    (account) => account.isVerified
      || (account.followers || 0) >= 10_000
      || account.totalEngagement >= 5_000,
  );
  const influencerReach = influencers.reduce(
    (sum, account) => sum + (account.followers || 0),
    0,
  );
  const repeatShillers = shillers.filter((account) => account.tweets >= 2).length;
  const qualityAccounts = shillers.filter(
    (account) => !account.isBot
      && (
        account.isVerified
        || account.totalEngagement >= 2_500
        || (account.followers || 0) >= 5_000
      ),
  ).length;

  const normalizedTexts = [
    ...tweets.map((tweet) => tweet.text),
    ...telegramItems.map((item) => item.text),
  ].map(normalizeText).filter((text) => text.length >= 16);
  const frequencies = new Map<string, number>();
  for (const text of normalizedTexts) {
    frequencies.set(text, (frequencies.get(text) || 0) + 1);
  }
  const copied = [...frequencies.values()]
    .filter((count) => count > 1)
    .reduce((sum, count) => sum + count, 0);
  const copyRatio = normalizedTexts.length
    ? (copied / normalizedTexts.length) * 100
    : 0;

  const recentXTweets = tweets.filter((tweet) => {
    const time = toTimestamp(tweet.timestamp);
    return time != null && time >= now - HOUR_MS;
  });
  const botBurst = recentXTweets.length
    ? (recentXTweets.filter((tweet) => tweet.isSuspicious).length / recentXTweets.length) * 100
    : 0;

  const tgKeys = new Set(
    telegramItems.flatMap((item) => [item.source_handle, item.source_name]
      .filter(Boolean)
      .map((value) => normalizeSource(String(value)))),
  );
  const relatedChannels = channels.filter((channel) => {
    const username = normalizeSource(channel.username);
    const title = normalizeSource(channel.title);
    return (username && tgKeys.has(username)) || (title && tgKeys.has(title));
  });
  const channelScore = relatedChannels.length
    ? average(relatedChannels.map((channel) => clamp(numberOr(channel.score))))
    : null;
  const evaluatedCalls = relatedChannels.reduce(
    (sum, channel) => sum + Math.max(0, numberOr(channel.evaluated_calls, 0)),
    0,
  );
  const winRate = relatedChannels.length ? weightedChannelRate(relatedChannels, "win_rate") : null;
  const rugRate = relatedChannels.length ? weightedChannelRate(relatedChannels, "rug_rate") : null;
  const hasMatureReputation = evaluatedCalls > 0 || relatedChannels.some(
    (channel) => numberOr(channel.calls_count, 0) > 0,
  );
  const explicitCalls = telegramItems.filter(
    (item) => Boolean(item.metrics?.explicit_call || item.metrics?.is_explicit_call)
      || String(item.event_type || "").toLowerCase().includes("call"),
  ).length;

  const aiCoordination = aiSignalScore(aiResult?.coordinationSignals);
  const aiRisk = aiSignalScore(aiResult?.risks);
  const repeatRisk = clamp(repeatShillers * 8);
  const coordinationScore = weightedScore([
    { value: normalizedTexts.length >= 2 ? copyRatio : null, weight: 0.45 },
    { value: aiResult ? aiCoordination : null, weight: 0.35 },
    { value: xAvailable ? repeatRisk : null, weight: 0.20 },
  ], 0.15).score;
  const paid = weightedScore([
    { value: coordinationScore, weight: 0.45 },
    { value: xAvailable ? botRisk : null, weight: 0.25 },
    { value: xAvailable ? repeatRisk : null, weight: 0.15 },
    { value: aiResult ? aiRisk : null, weight: 0.15 },
  ], 0.1).score;
  const tgDiffusion = tgMentions > 0
    ? clamp((tgKeys.size / tgMentions) * 100)
    : 0;
  const organic = weightedScore([
    { value: 100 - paid, weight: 0.55 },
    { value: normalizedTexts.length >= 2 ? 100 - copyRatio : null, weight: 0.20 },
    { value: xAvailable && xMentions > 0 ? authorRatio : null, weight: 0.15 },
    { value: tgAvailable && tgMentions > 0 ? tgDiffusion : null, weight: 0.10 },
  ], 0.08).score;

  const engagementSignal = xAvailable
    ? clamp(Math.log10((x?.aggregated.totalEngagement || 0) + 1) * 20)
    : 0;
  const xScore = xAvailable
    ? weightedScore([
        { value: xMentions > 0 ? botCleanliness : 0, weight: 0.30 },
        { value: xMentions > 0 ? authorRatio : 0, weight: 0.25 },
        { value: xMentions > 0 ? engagementSignal : 0, weight: 0.25 },
        { value: xMentions > 0 ? followerQuality : 0, weight: 0.20 },
      ]).score
    : 0;

  const tgScore = tgAvailable
    ? weightedScore([
        { value: channelScore, weight: 0.30 },
        { value: hasMatureReputation ? winRate : null, weight: 0.20 },
        { value: hasMatureReputation && rugRate != null ? 100 - rugRate : null, weight: 0.20 },
        { value: clamp(tgKeys.size * 7), weight: 0.15 },
        { value: clamp(explicitCalls * 8), weight: 0.15 },
      ], 0.35).score
    : 0;

  const crossLag = both ? Math.abs(firstX - firstTg) / 60_000 : null;
  const crossLagScore = crossLag == null
    ? null
    : clamp(100 - (crossLag / 180) * 100);
  const activityScore = clamp((xVelocity + tgVelocity) * 8);
  const cross = both
    ? weightedScore([
        { value: crossLagScore, weight: 0.80 },
        { value: activityScore, weight: 0.20 },
      ]).score
    : 0;

  const engagementRateScore = xAvailable && (x?.totalViews || 0) > 0
    ? clamp((x?.aggregated.engagementRate || 0) * 100)
    : null;
  const hype = weightedScore([
    { value: xAvailable ? xAcceleration : null, weight: 0.25 },
    { value: tgAvailable ? tgAcceleration : null, weight: 0.25 },
    { value: xAvailable || tgAvailable ? clamp((xVelocity + tgVelocity) * 10) : null, weight: 0.30 },
    { value: engagementRateScore, weight: 0.20 },
  ], 0.08).score;

  const availablePositiveSentiments = [
    xAvailable ? xSentiment.p : null,
    tgAvailable ? tgSentiment.p : null,
  ].filter((value): value is number => value != null);
  const positiveSentiment = availablePositiveSentiments.length
    ? Math.max(...availablePositiveSentiments)
    : null;
  const fomo = weightedScore([
    { value: hype, weight: 0.55 },
    { value: positiveSentiment, weight: 0.25 },
    { value: tgAvailable ? clamp(explicitCalls * 7) : null, weight: 0.20 },
  ]).score;

  const manipulation = weightedScore([
    { value: paid, weight: 0.65 },
    { value: coordinationScore, weight: 0.35 },
  ]).score;
  const socialRisk = weightedScore([
    { value: manipulation, weight: 0.40 },
    { value: xAvailable ? botRisk : null, weight: 0.20 },
    { value: hasMatureReputation ? rugRate : null, weight: 0.15 },
    { value: 100 - organic, weight: 0.15 },
    { value: aiResult ? aiRisk : null, weight: 0.10 },
  ], 0.05).score;
  const riskLevel = socialRisk >= 70 ? "HIGH" : socialRisk >= 40 ? "MEDIUM" : "LOW";

  const created = toTimestamp(market?.pair?.createdAt);
  const firstSocial = firstX == null
    ? firstTg
    : firstTg == null
      ? firstX
      : Math.min(firstX, firstTg);
  const earlyMinutes = created != null && firstSocial != null
    ? (firstSocial - created) / 60_000
    : null;
  const earlyKnown = earlyMinutes != null;
  const early = earlyKnown
    ? clamp(100 - Math.max(0, earlyMinutes) / 12)
    : 0;

  const alpha = weightedScore([
    { value: earlyKnown ? early : null, weight: 0.35 },
    { value: organic, weight: 0.25 },
    { value: 100 - manipulation, weight: 0.20 },
    { value: both ? cross : null, weight: 0.20 },
  ], 0.12).score;

  const socialCore = weightedScore([
    { value: xAvailable ? xScore : null, weight: 0.36 },
    { value: tgAvailable ? tgScore : null, weight: 0.34 },
    { value: xAvailable || tgAvailable ? organic : null, weight: 0.15 },
    { value: both ? cross : null, weight: 0.15 },
  ], 0.12).score;
  const activePlatformCoverage = (Number(xAvailable) + Number(tgAvailable)) / 2;
  const socialScore = clamp(socialCore * (0.85 + activePlatformCoverage * 0.15));

  const eventTimes = [...finiteX, ...finiteTg];
  const dense = densestWindow(eventTimes);
  const spike = dense.count >= 3 ? dense.time : null;
  const trades: TradePoint[] = (chain?.trades || [])
    .map((trade) => ({ time: toTimestamp(trade.ts), price: Number(trade.p) }))
    .filter(
      (trade): trade is TradePoint => trade.time != null
        && Number.isFinite(trade.price)
        && trade.price > 0,
    )
    .sort((a, b) => a.time - b.time);
  const impulse = findPriceImpulse(trades, spike);
  const p0 = spike == null ? null : priceAtOrBefore(trades, spike, 5 * 60_000);
  const p5 = spike == null
    ? null
    : priceAtOrAfter(trades, spike + 5 * 60_000, 5 * 60_000);
  const p15 = spike == null
    ? null
    : priceAtOrAfter(trades, spike + 15 * 60_000, 5 * 60_000);
  const p60 = spike == null
    ? null
    : priceAtOrAfter(trades, spike + HOUR_MS, 10 * 60_000);
  const r5 = priceChange(p0, p5);
  const r15 = priceChange(p0, p15);
  const r60 = priceChange(p0, p60);
  const oneHour = spike == null
    ? []
    : trades.filter((trade) => trade.time >= spike && trade.time <= spike + HOUR_MS);
  const maxPrice = oneHour.length
    ? Math.max(...oneHour.map((trade) => trade.price))
    : null;
  const minPrice = oneHour.length
    ? Math.min(...oneHour.map((trade) => trade.price))
    : null;
  const maxUp = p0 && maxPrice != null
    ? Math.max(0, ((maxPrice - p0.price) / p0.price) * 100)
    : null;
  const maxDd = p0 && minPrice != null
    ? Math.min(0, ((minPrice - p0.price) / p0.price) * 100)
    : null;
  const leadLag = spike != null && impulse
    ? (impulse.time - spike) / 60_000
    : null;
  const direction = leadLag == null
    ? "—"
    : Math.abs(leadLag) <= 2
      ? "SYNC"
      : leadLag > 0
        ? "SOCIAL → PRICE"
        : "PRICE → SOCIAL";
  const confidence = leadLag == null
    ? null
    : clamp(
        20
        + Math.min(40, dense.count * 8)
        + Math.min(25, trades.length / 20)
        + Math.min(15, eventTimes.length)
        - (chain?.truncated ? 15 : 0),
      );
  const price: PriceSocial = {
    socialSpikeTime: spike,
    reaction5: r5,
    reaction15: r15,
    reaction60: r60,
    maxUpside: maxUp,
    maxDrawdown: maxDd,
    impulseTime: impulse?.time ?? null,
    impulseChange: impulse?.change ?? null,
    leadLagMinutes: leadLag,
    leadDirection: direction,
    leadLagConfidence: confidence,
    tradeCount: trades.length,
  };

  const firstXAuthor = [...tweets]
    .filter((tweet) => toTimestamp(tweet.timestamp) != null)
    .sort(
      (a, b) => numberOr(toTimestamp(a.timestamp)) - numberOr(toTimestamp(b.timestamp)),
    )[0]?.author || "—";
  const firstTgSource = tg?.origin?.source_handle
    || tg?.origin?.source_name
    || [...telegramItems]
      .filter((item) => toTimestamp(item.occurred_at) != null)
      .sort(
        (a, b) => numberOr(toTimestamp(a.occurred_at)) - numberOr(toTimestamp(b.occurred_at)),
      )[0]?.source_handle
    || "—";
  const sentimentChanges = [xSentimentDelta, tgSentimentDelta]
    .filter((value): value is number => value != null);
  const combinedDelta = sentimentChanges.length ? average(sentimentChanges) : null;
  const narrative = aiResult?.campaignHypothesis?.narrative || "—";
  const campaign = aiResult?.campaignHypothesis?.label || "—";
  const narrativeStrength = weightedScore([
    { value: aiResult?.campaignHypothesis?.confidence != null ? numberOr(aiResult.campaignHypothesis.confidence) * 100 : null, weight: 0.55 },
    { value: hype, weight: 0.25 },
    { value: both ? cross : null, weight: 0.20 },
  ], 0.15).score;
  const xSampleNote = x?.collectionTruncated
    ? "filtered sample; collector/API limit reached"
    : "filtered collector sample";
  const tgSampleNote = tg?.meta?.truncated
    ? "filtered timeline truncated by limit"
    : "filtered timeline";

  const groups: DerivedSocial["groups"] = [
    {
      title: "X / Twitter",
      rows: [
        metric("X score", xAvailable ? score(xScore) : "—"),
        metric("Mentions", xAvailable ? compact(xMentions) : "—", xSampleNote),
        metric("Mentions 5m", xAvailable ? String(xWindow.m5) : "—", "sampled top posts"),
        metric("Mentions 15m", xAvailable ? String(xWindow.m15) : "—", "sampled top posts"),
        metric("Mentions 1h", xAvailable ? String(xWindow.h1) : "—", "sampled top posts"),
        metric("Mentions 6h", xAvailable ? String(xWindow.h6) : "—", "sampled top posts"),
        metric("Mentions 24h", xAvailable ? String(xWindow.h24) : "—", "sampled top posts"),
        metric("Mentions / h", xAvailable ? xVelocity.toFixed(2) : "—", "sample count / requested lookback"),
        metric("Acceleration", xAvailable ? score(xAcceleration) : "—", "50≈stable; >50 accelerating vs 15m average"),
        metric("Unique authors", xAvailable ? compact(x?.uniqueMentioners) : "—"),
        metric("Unique authors 6h", xAvailable ? String(xWindow.unique6) : "—", "sampled top posts"),
        metric("Unique authors 24h", xAvailable ? String(xWindow.unique24) : "—", "sampled top posts"),
        metric("Author growth 6h", xAvailable ? signedPct(growthPct(xWindow.unique6, xWindow.uniquePrev6)) : "—", "vs previous 6h; sampled"),
        metric("Author diffusion", xAvailable ? pct(authorRatio) : "—"),
        metric("Views", xAvailable ? compact(x?.totalViews) : "—"),
        metric("Likes", xAvailable ? compact(x?.totalLikes) : "—"),
        metric("Reposts", xAvailable ? compact(x?.totalRetweets) : "—"),
        metric("Engagement", xAvailable ? compact(x?.aggregated.totalEngagement) : "—"),
        metric("Engagement rate", xAvailable ? pct((x?.aggregated.engagementRate || 0) * 100) : "—", "engagement / views"),
        metric("Verified authors", xAvailable ? compact(x?.aggregated.verifiedAuthors) : "—"),
        metric("Verified ratio", xAvailable ? pct(verifiedRatio) : "—"),
        metric("Influencers", xAvailable ? String(influencers.length) : "—", "verified / ≥10k followers / high engagement proxy"),
        metric("Potential reach", xAvailable ? compact(reach) : "—", "sum of known follower counts; not unique reach"),
        metric("Influencer reach", xAvailable ? compact(influencerReach) : "—", "sum of known follower counts; not unique reach"),
        metric("Quality accounts (proxy)", xAvailable ? String(qualityAccounts) : "—", "not historical smart-money classification"),
        metric("Repeat shillers", xAvailable ? String(repeatShillers) : "—"),
        metric("Bot risk", xAvailable ? score(botRisk) : "—"),
        metric("Bot ratio", xAvailable ? pct(botRatio) : "—"),
        metric("Bot burst 1h", xAvailable ? pct(botBurst) : "—", "sampled top posts"),
        metric("Anomalies", xAvailable ? String(x?.anomalyCount || 0) : "—"),
        metric("Follower quality", xAvailable ? score(followerQuality) : "—", "coverage-aware proxy"),
        metric("Sentiment", xAvailable ? xSentiment.label : "—", "deterministic lexicon"),
        metric("Positive", xAvailable ? pct(xSentiment.p) : "—"),
        metric("Neutral", xAvailable ? pct(xSentiment.u) : "—"),
        metric("Negative", xAvailable ? pct(xSentiment.n) : "—"),
        metric("Sentiment change", xAvailable ? signedPct(xSentimentDelta) : "—"),
        metric("First mover", xAvailable ? firstXAuthor : "—", "earliest retained X post"),
        metric("First mention", firstX != null ? ago(firstX, now) : "—", "earliest retained X post"),
        metric("Account age", "—", "X collector does not expose account creation date"),
      ],
    },
    {
      title: "Telegram",
      rows: [
        metric("TG score", tgAvailable ? score(tgScore) : "—", "coverage-penalized when reputation history is missing"),
        metric("Mentions", tgAvailable ? compact(tgMentions) : "—", tgSampleNote),
        metric("Mentions 5m", tgAvailable ? String(tgWindow.m5) : "—"),
        metric("Mentions 15m", tgAvailable ? String(tgWindow.m15) : "—"),
        metric("Mentions 1h", tgAvailable ? String(tgWindow.h1) : "—"),
        metric("Mentions 6h", tgAvailable ? String(tgWindow.h6) : "—"),
        metric("Mentions 24h", tgAvailable ? String(tgWindow.h24) : "—"),
        metric("Mentions / h", tgAvailable ? tgVelocity.toFixed(2) : "—", "sample count / requested lookback"),
        metric("Acceleration", tgAvailable ? score(tgAcceleration) : "—", "50≈stable; >50 accelerating vs 15m average"),
        metric("Channels", tgAvailable ? String(tgKeys.size) : "—", tgSampleNote),
        metric("Channels 6h", tgAvailable ? String(tgWindow.unique6) : "—"),
        metric("Channels 24h", tgAvailable ? String(tgWindow.unique24) : "—"),
        metric("Channel growth 6h", tgAvailable ? signedPct(growthPct(tgWindow.unique6, tgWindow.uniquePrev6)) : "—", "vs previous 6h"),
        metric("Explicit calls", tgAvailable ? String(explicitCalls) : "—"),
        metric("Channel score", channelScore != null ? score(channelScore) : "—"),
        metric("Evaluated historical calls", relatedChannels.length ? compact(evaluatedCalls) : "—"),
        metric("Historical win rate", winRate != null ? pct(winRate) : "—", evaluatedCalls ? "weighted by evaluated calls" : "reputation coverage unavailable"),
        metric("Historical rug rate", rugRate != null ? pct(rugRate) : "—", evaluatedCalls ? "weighted by evaluated calls" : "reputation coverage unavailable"),
        metric("Sentiment", aiResult?.sentiment?.label || (tgAvailable ? tgSentiment.label : "—")),
        metric("AI sentiment score", aiResult?.sentiment?.score != null ? numberOr(aiResult.sentiment.score).toFixed(2) : "—"),
        metric("AI sentiment confidence", aiResult?.sentiment?.confidence != null ? pct(numberOr(aiResult.sentiment.confidence) * 100) : "—", "raw model confidence"),
        metric("Window sentiment change", tgAvailable ? signedPct(tgSentimentDelta) : "—"),
        metric("Dominant intent", aiResult?.dominantIntent || "—"),
        metric("Top/first source", tgAvailable ? firstTgSource : "—", "earliest retained TG event"),
        metric("First signal", firstTg != null ? ago(firstTg, now) : "—", "earliest retained TG event"),
        metric("AI campaign", campaign),
        metric("AI coordination score", aiResult ? score(aiCoordination) : "—", "severity × confidence, count pressure capped"),
        metric("AI risk score", aiResult ? score(aiRisk) : "—", "severity × confidence, count pressure capped"),
        metric("AI overall confidence", aiResult?.overallConfidence != null ? pct(numberOr(aiResult.overallConfidence) * 100) : "—", "raw model confidence; not calibrated probability"),
      ],
    },
    {
      title: "Growth / Quality / Manipulation",
      rows: [
        metric("Hype score", score(hype)),
        metric("FOMO score", score(fomo)),
        metric("Organic score", score(organic), "missing-aware evidence blend"),
        metric("Paid promotion risk", score(paid)),
        metric("Manipulation score", score(manipulation)),
        metric("Social risk", score(socialRisk)),
        metric("Social risk level", riskLevel),
        metric("Coordination score", score(coordinationScore)),
        metric("Copy-paste ratio", pct(copyRatio), "exact normalized text duplicates; semantic clusters are separate"),
        metric("Follower quality", xAvailable ? score(followerQuality) : "—"),
        metric("Narrative strength", aiResult ? score(narrativeStrength) : "—", "AI campaign confidence + current social support"),
        metric("Narrative", narrative),
        metric("Campaign hypothesis", campaign),
        metric("Peak sample velocity", `${Math.max(xVelocity, tgVelocity).toFixed(2)}/h`),
        metric("Velocity change", score(weightedScore([
          { value: xAvailable ? xAcceleration : null, weight: 0.5 },
          { value: tgAvailable ? tgAcceleration : null, weight: 0.5 },
        ]).score)),
        metric("Sentiment change", signedPct(combinedDelta), "positive-share change inside sampled window"),
      ],
    },
    {
      title: "Cross-platform / Timing",
      rows: [
        metric("Cross-platform score", both ? score(cross) : "—", "80% timing proximity + 20% activity"),
        metric("Both platforms active", both ? "YES" : "NO"),
        metric("TG → X lag", firstX != null && firstTg != null && firstTg <= firstX ? `${Math.round((firstX - firstTg) / 60_000)}m` : "—", "based on retained samples"),
        metric("X → TG lag", firstX != null && firstTg != null && firstX < firstTg ? `${Math.round((firstTg - firstX) / 60_000)}m` : "—", "based on retained samples"),
        metric("First X", firstX != null ? ago(firstX, now) : "—", "earliest retained post"),
        metric("First TG", firstTg != null ? ago(firstTg, now) : "—", "earliest retained event"),
        metric("Social spike", spike == null ? "—" : ago(spike, now), `densest 5m window; requires ≥3 events (found ${dense.count})`),
        metric("Early signal score", earlyKnown ? score(early) : "—", "requires token creation timestamp + social timestamp"),
        metric("Alpha score", score(alpha), "missing components excluded with coverage penalty"),
        metric("Social score", score(socialScore), "missing sources are not treated as zero-quality evidence"),
        metric("Price ↔ Social direction", direction),
        metric("Lead / lag", leadLag == null ? "—" : `${Math.abs(leadLag).toFixed(1)}m`),
        metric("Lead/lag confidence", score(confidence), "density + trade coverage; truncated history penalized"),
        metric("Price after social 5m", signedPct(r5)),
        metric("Price after social 15m", signedPct(r15)),
        metric("Price after social 1h", signedPct(r60)),
        metric("Max upside 1h", signedPct(maxUp)),
        metric("Max drawdown 1h", signedPct(maxDd)),
        metric("Nearest 5m price impulse", impulse ? signedPct(impulse.change) : "—"),
        metric("Price 1h snapshot", signedPct(market?.pair?.changeH1)),
        metric("Price 24h snapshot", signedPct(market?.pair?.change24h)),
        metric("Volume 1h", money(market?.pair?.volumeH1)),
        metric("Volume 24h", money(market?.pair?.volumeH24)),
        metric("Liquidity", money(market?.pair?.liquidityUsd)),
      ],
    },
    {
      title: "Price event evidence",
      rows: [
        metric("Trades sampled", chain ? compact(trades.length) : "—"),
        metric("Trade history start", trades.length ? ago(trades[0].time, now) : "—"),
        metric("Trade history end", trades.length ? ago(trades[trades.length - 1].time, now) : "—"),
        metric("Price at social spike", p0 ? p0.price.toPrecision(6) : "—", "last trade at/before spike within 5m; SOL price"),
        metric("Price +5m", p5 ? p5.price.toPrecision(6) : "—", "first trade at/after target within 5m"),
        metric("Price +15m", p15 ? p15.price.toPrecision(6) : "—", "first trade at/after target within 5m"),
        metric("Price +1h", p60 ? p60.price.toPrecision(6) : "—", "first trade at/after target within 10m"),
        metric("Impulse timestamp", impulse ? ago(impulse.time, now) : "—"),
        metric("Impulse threshold", `${IMPULSE_THRESHOLD_PCT}% / ${IMPULSE_WINDOW_MS / 60_000}m`),
        metric("On-chain raw trades", compact(chain?.summary?.totalRawTrades ?? chain?.summary?.totalTrades)),
        metric("Unique wallets", compact(chain?.summary?.uniqueWallets)),
        metric("Wallets enriched", chain ? compact(chain.wallets?.length) : "—"),
        metric("Bundles detected", chain ? compact(chain.bundles?.length) : "—"),
        metric("History truncated", chain?.truncated == null ? "—" : chain.truncated ? "YES" : "NO"),
      ],
    },
    {
      title: "AI Agent / Evidence",
      rows: [
        metric("Agent", ai?.available ? `${ai.provider || "qwen"} · ${ai.model || "Qwen"}` : ai ? "unavailable" : "—"),
        metric("AI latency", ai?.latencyMs != null ? `${Math.round(ai.latencyMs)} ms` : "—"),
        metric("AI cache", ai?.cache || "—"),
        metric("Summary", aiResult?.summary || "—"),
        metric("Claims", aiResult ? String(aiResult.claims?.length || 0) : "—"),
        metric("Entities", aiResult ? String(aiResult.entities?.length || 0) : "—"),
        metric("Relationships", aiResult ? String(aiResult.relationships?.length || 0) : "—"),
        metric("Risks", aiResult ? String(aiResult.risks?.length || 0) : "—"),
        metric("Originators", aiResult?.campaignHypothesis?.likelyOriginators?.join(", ") || "—"),
        metric("Amplifiers", aiResult?.campaignHypothesis?.amplifiers?.slice(0, 6).join(", ") || "—"),
      ],
    },
  ];

  return {
    groups,
    xScore,
    tgScore,
    organic,
    manipulation,
    socialRisk,
    early,
    alpha,
    socialScore,
    price,
  };
}
