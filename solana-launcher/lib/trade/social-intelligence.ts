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

export type TwitterRiskUniverse = {
  totalTweets?: number;
  uniqueAuthors?: number;
  suspiciousTweets?: number;
  botAccounts?: number;
  botRiskScore?: number;
  botRatio?: number;
  anomalyCount?: number;
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
  collectionStrategy?: string;
  riskUniverse?: TwitterRiskUniverse;
  meta?: {
    scraped?: number;
    matchedBeforeLimit?: number;
    returned?: number;
    truncated?: boolean;
    queryMode?: "top" | "latest" | "unknown";
    suspiciousExcluded?: boolean;
    verifiedOnly?: boolean;
  };
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
    returned?: number;
    truncated?: boolean;
    matchedPlatforms?: Record<string, number>;
    uniqueSourcesBeforeLimit?: number;
    explicitTelegramCallsBeforeLimit?: number;
    firstMatchedAt?: string | null;
    lastMatchedAt?: string | null;
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
    createdAtSemantics?: string | null;
    changeH1?: number | null;
    change24h?: number | null;
    volumeH1?: number | null;
    volumeH24?: number | null;
    liquidityUsd?: number | null;
  };
  meta?: {
    source?: string;
    stale?: boolean;
    fetchedAt?: number;
    servedAt?: number;
    cache?: string;
  };
};

export type ChainWallet = {
  address: string;
  buys?: number;
  sells?: number;
  volumeSol?: number;
  pnlSol?: number;
  pnlPercent?: number;
  pnlComplete?: boolean;
  pnlMethod?: string;
  solBalance?: number | null;
  balanceVerified?: boolean;
  isFresh?: boolean | null;
  freshnessVerified?: boolean;
  firstSeenGlobal?: number | null;
  firstSeenOnToken?: number | null;
  isSmart?: boolean | null;
  smartClassificationAvailable?: boolean;
  isWashTrader?: boolean;
  washConfidence?: number;
  washReasons?: string[];
  bundleId?: string | number | null;
  bundleMethod?: string | null;
  coBuyProximityCount?: number;
  coBuyProximityWindowSec?: number;
  historyTruncated?: boolean;
};

export type ChainBundle = {
  id: string | number;
  size?: number;
  totalVolumeSol?: number;
  wallets?: string[];
  method?: string;
  heuristic?: boolean;
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
    historyTruncated?: boolean;
    maxTradesRequested?: number;
  };
};

export type AiSignal = { severity?: string; confidence?: number };

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
  return sentiment(sorted.slice(middle).map((row) => row.text)).p
    - sentiment(sorted.slice(0, middle).map((row) => row.text)).p;
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
  const fullRate = window.m15 / 15;
  return clamp((recentRate / Math.max(fullRate, 1e-9)) * 50);
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
  return {
    time: sorted[Math.floor((bestStart + bestEnd) / 2)],
    count: bestEnd - bestStart + 1,
  };
}

function crossPlatformAlignment(xTimes: number[], tgTimes: number[]) {
  if (!xTimes.length || !tgTimes.length) {
    return { score: 0, medianLagMinutes: null as number | null, matchedShare: 0 };
  }
  const x = [...xTimes].sort((a, b) => a - b);
  const tg = [...tgTimes].sort((a, b) => a - b);
  const lags: number[] = [];
  const cutoff = 30 * 60_000;
  for (const time of x) {
    let best = Infinity;
    for (const other of tg) {
      const distance = Math.abs(time - other);
      if (distance < best) best = distance;
      if (other > time && distance > best) break;
    }
    if (best <= cutoff) lags.push(best);
  }
  for (const time of tg) {
    let best = Infinity;
    for (const other of x) {
      const distance = Math.abs(time - other);
      if (distance < best) best = distance;
      if (other > time && distance > best) break;
    }
    if (best <= cutoff) lags.push(best);
  }
  const denominator = x.length + tg.length;
  const matchedShare = denominator ? lags.length / denominator : 0;
  const medianLagMinutes = lags.length ? median(lags) / 60_000 : null;
  const lagScore = medianLagMinutes == null
    ? 0
    : clamp(100 - (medianLagMinutes / 30) * 100);
  return {
    score: clamp(lagScore * 0.6 + matchedShare * 100 * 0.4),
    medianLagMinutes,
    matchedShare,
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
    if (socialTime != null && Math.abs(trade.time - socialTime) > 6 * HOUR_MS) {
      continue;
    }
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

function peakToSubsequentDrawdown(
  baseline: TradePoint | null,
  rows: TradePoint[],
) {
  if (!baseline || baseline.price <= 0) return null;
  let peak = baseline.price;
  let worst = 0;
  for (const row of rows) {
    if (row.price > peak) peak = row.price;
    if (peak <= 0) continue;
    worst = Math.min(worst, ((row.price - peak) / peak) * 100);
  }
  return worst;
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
  return clamp(
    average(values) + Math.min(25, Math.max(0, signals.length - 1) * 4),
  );
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
    .filter(
      (row): row is { value: number; weight: number } => (
        row.value != null && row.weight > 0
      ),
    );
  if (!eligible.length) return null;
  const weight = eligible.reduce((sum, row) => sum + row.weight, 0);
  return eligible.reduce(
    (sum, row) => sum + row.value * row.weight,
    0,
  ) / weight;
}

function pairRelativeEarlyScore(minutesAfterPairCreation: number) {
  if (minutesAfterPairCreation <= 0) return 100;
  return clamp(100 - (minutesAfterPairCreation / 120) * 100);
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
  const firstTg = toTimestamp(tg?.meta?.firstMatchedAt)
    ?? (finiteTg.length ? Math.min(...finiteTg) : null);
  const both = finiteX.length > 0 && finiteTg.length > 0;

  const requestedHours = Math.max(
    1,
    options.lookback === "all" ? 720 : Number(options.lookback),
  );
  const xMentions = x?.totalTweets || 0;
  const tgMentions = tg?.meta?.matchedPlatforms?.telegram
    ?? tg?.meta?.matchedBeforeLimit
    ?? tg?.platforms?.telegram
    ?? telegramItems.length;
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
  const riskUniverse = x?.riskUniverse;
  const botRisk = xAvailable
    ? clamp(riskUniverse?.botRiskScore ?? x?.botRiskScore ?? 0)
    : 0;
  const botRatio = normalizeRatePct(
    riskUniverse?.botRatio ?? x?.aggregated.botRatio,
  ) ?? 0;
  const anomalyCount = riskUniverse?.anomalyCount ?? x?.anomalyCount ?? 0;
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
    ? (recentXTweets.filter((tweet) => tweet.isSuspicious).length
      / recentXTweets.length) * 100
    : 0;

  const retainedTgKeys = new Set(
    telegramItems.flatMap((item) => [item.source_handle, item.source_name]
      .filter(Boolean)
      .map((value) => normalizeSource(String(value)))),
  );
  const tgSourceCount = tg?.meta?.uniqueSourcesBeforeLimit ?? retainedTgKeys.size;
  const relatedChannels = channels.filter((channel) => {
    const username = normalizeSource(channel.username);
    const title = normalizeSource(channel.title);
    return (username && retainedTgKeys.has(username))
      || (title && retainedTgKeys.has(title));
  });
  const evaluatedCalls = relatedChannels.reduce(
    (sum, channel) => sum + Math.max(0, numberOr(channel.evaluated_calls, 0)),
    0,
  );
  const reputationWeight = relatedChannels.reduce(
    (sum, channel) => sum + Math.max(1, numberOr(channel.evaluated_calls, 0)),
    0,
  );
  const channelScore = relatedChannels.length && reputationWeight > 0
    ? relatedChannels.reduce(
        (sum, channel) => sum
          + clamp(numberOr(channel.score))
          * Math.max(1, numberOr(channel.evaluated_calls, 0)),
        0,
      ) / reputationWeight
    : null;
  const winRate = weightedChannelRate(relatedChannels, "win_rate");
  const rugRate = weightedChannelRate(relatedChannels, "rug_rate");
  const hasMatureReputation = evaluatedCalls > 0;
  const explicitCalls = tg?.meta?.explicitTelegramCallsBeforeLimit
    ?? telegramItems.filter(
      (item) => Boolean(item.metrics?.explicit_call || item.metrics?.is_explicit_call)
        || String(item.event_type || "").toLowerCase().includes("call"),
    ).length;

  const repeatRisk = clamp(repeatShillers * 8);
  const coordinationScore = weightedScore([
    { value: normalizedTexts.length >= 2 ? copyRatio : null, weight: 0.52 },
    { value: xAvailable ? repeatRisk : null, weight: 0.28 },
    { value: xAvailable ? botBurst : null, weight: 0.20 },
  ], 0.12).score;
  const paid = weightedScore([
    { value: coordinationScore, weight: 0.50 },
    { value: xAvailable ? botRisk : null, weight: 0.30 },
    { value: xAvailable ? repeatRisk : null, weight: 0.20 },
  ], 0.1).score;
  const tgDiffusion = tgMentions > 0
    ? clamp((tgSourceCount / tgMentions) * 100)
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
  const callDensity = tgMentions > 0
    ? clamp((explicitCalls / tgMentions) * 100)
    : 0;
  const tgScore = tgAvailable
    ? weightedScore([
        { value: channelScore, weight: 0.30 },
        { value: hasMatureReputation ? winRate : null, weight: 0.20 },
        {
          value: hasMatureReputation && rugRate != null ? 100 - rugRate : null,
          weight: 0.20,
        },
        { value: clamp(tgSourceCount * 7), weight: 0.15 },
        { value: callDensity, weight: 0.15 },
      ], 0.35).score
    : 0;

  const alignment = crossPlatformAlignment(finiteX, finiteTg);
  const cross = both ? alignment.score : 0;
  const engagementRateScore = xAvailable && (x?.totalViews || 0) > 0
    ? clamp((x?.aggregated.engagementRate || 0) * 100)
    : null;
  const hype = weightedScore([
    { value: xAvailable ? xAcceleration : null, weight: 0.25 },
    { value: tgAvailable ? tgAcceleration : null, weight: 0.25 },
    {
      value: xAvailable || tgAvailable
        ? clamp((xVelocity + tgVelocity) * 10)
        : null,
      weight: 0.30,
    },
    { value: engagementRateScore, weight: 0.20 },
  ], 0.08).score;
  const positiveSentiments = [
    xAvailable ? xSentiment.p : null,
    tgAvailable ? tgSentiment.p : null,
  ].filter((value): value is number => value != null);
  const positiveSentiment = positiveSentiments.length
    ? Math.max(...positiveSentiments)
    : null;
  const fomo = weightedScore([
    { value: hype, weight: 0.55 },
    { value: positiveSentiment, weight: 0.25 },
    { value: tgAvailable ? callDensity : null, weight: 0.20 },
  ]).score;
  const manipulation = weightedScore([
    { value: paid, weight: 0.65 },
    { value: coordinationScore, weight: 0.35 },
  ]).score;
  const socialRisk = weightedScore([
    { value: manipulation, weight: 0.45 },
    { value: xAvailable ? botRisk : null, weight: 0.25 },
    { value: hasMatureReputation ? rugRate : null, weight: 0.15 },
    { value: 100 - organic, weight: 0.15 },
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
  const early = earlyKnown ? pairRelativeEarlyScore(earlyMinutes) : 0;
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
  const socialScore = clamp(
    socialCore.score * (0.85 + activePlatformCoverage * 0.15),
  );

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
    .sort((left, right) => left.time - right.time);
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
  const maxUp = p0 && maxPrice != null
    ? Math.max(0, ((maxPrice - p0.price) / p0.price) * 100)
    : null;
  const maxDd = peakToSubsequentDrawdown(p0, oneHour);
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
  const socialSamplingPenalty = Number(Boolean(x?.meta?.truncated)) * 8
    + Number(Boolean(tg?.meta?.truncated)) * 8;
  const confidence = leadLag == null
    ? null
    : clamp(
        20
        + Math.min(40, dense.count * 8)
        + Math.min(25, trades.length / 20)
        + Math.min(15, eventTimes.length)
        - (chain?.truncated ? 15 : 0)
        - socialSamplingPenalty,
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
      (left, right) => numberOr(toTimestamp(left.timestamp))
        - numberOr(toTimestamp(right.timestamp)),
    )[0]?.author || "—";
  const firstTgSource = tg?.origin?.source_handle
    || tg?.origin?.source_name
    || [...telegramItems]
      .filter((item) => toTimestamp(item.occurred_at) != null)
      .sort(
        (left, right) => numberOr(toTimestamp(left.occurred_at))
          - numberOr(toTimestamp(right.occurred_at)),
      )[0]?.source_handle
    || "—";
  const sentimentChanges = [xSentimentDelta, tgSentimentDelta]
    .filter((value): value is number => value != null);
  const combinedDelta = sentimentChanges.length ? average(sentimentChanges) : null;
  const aiCoordination = aiSignalScore(aiResult?.coordinationSignals);
  const aiRisk = aiSignalScore(aiResult?.risks);
  const narrative = aiResult?.campaignHypothesis?.narrative || "—";
  const campaign = aiResult?.campaignHypothesis?.label || "—";
  const narrativeStrength = weightedScore([
    {
      value: aiResult?.campaignHypothesis?.confidence != null
        ? numberOr(aiResult.campaignHypothesis.confidence) * 100
        : null,
      weight: 0.55,
    },
    { value: hype, weight: 0.25 },
    { value: both ? cross : null, weight: 0.20 },
  ], 0.15).score;

  const xSampleNote = [
    x?.meta?.queryMode === "top" ? "X top-search sample" : "collector sample",
    x?.meta?.truncated || x?.collectionTruncated ? "truncated" : null,
    x?.meta?.suspiciousExcluded ? "suspicious posts excluded from display sample" : null,
  ].filter(Boolean).join("; ");
  const tgExactNote = tg?.meta?.truncated
    ? "exact filtered count before retained timeline limit"
    : "filtered backend count";
  const tgRetainedNote = tg?.meta?.truncated
    ? "retained latest timeline sample"
    : "returned timeline";
  const marketStaleNote = market?.meta?.stale ? "stale market fallback" : undefined;

  const groups: DerivedSocial["groups"] = [
    {
      title: "X / Twitter",
      rows: [
        metric("X score", xAvailable ? score(xScore) : "—", "deterministic; raw bot risk + filtered sample quality"),
        metric("Mentions", xAvailable ? compact(xMentions) : "—", xSampleNote),
        metric("Mentions 5m", xAvailable ? String(xWindow.m5) : "—", "retained top-post sample"),
        metric("Mentions 15m", xAvailable ? String(xWindow.m15) : "—", "retained top-post sample"),
        metric("Mentions 1h", xAvailable ? String(xWindow.h1) : "—", "retained top-post sample"),
        metric("Mentions 6h", xAvailable ? String(xWindow.h6) : "—", "retained top-post sample"),
        metric("Mentions 24h", xAvailable ? String(xWindow.h24) : "—", "retained top-post sample"),
        metric("Mentions / h", xAvailable ? xVelocity.toFixed(2) : "—", "filtered sample / requested lookback; not population velocity"),
        metric("Acceleration", xAvailable ? score(xAcceleration) : "—", "50≈stable; retained 5m rate vs retained 15m average"),
        metric("Unique authors", xAvailable ? compact(x?.uniqueMentioners) : "—", "filtered sample"),
        metric("Unique authors 6h", xAvailable ? String(xWindow.unique6) : "—", "retained top-post sample"),
        metric("Unique authors 24h", xAvailable ? String(xWindow.unique24) : "—", "retained top-post sample"),
        metric("Author growth 6h", xAvailable ? signedPct(growthPct(xWindow.unique6, xWindow.uniquePrev6)) : "—", "retained sample vs previous 6h"),
        metric("Author diffusion", xAvailable ? pct(authorRatio) : "—", "unique authors / filtered sample mentions"),
        metric("Views", xAvailable ? compact(x?.totalViews) : "—", "filtered sample"),
        metric("Likes", xAvailable ? compact(x?.totalLikes) : "—", "filtered sample"),
        metric("Reposts", xAvailable ? compact(x?.totalRetweets) : "—", "filtered sample"),
        metric("Engagement", xAvailable ? compact(x?.aggregated.totalEngagement) : "—", "filtered sample"),
        metric("Engagement rate", xAvailable ? pct((x?.aggregated.engagementRate || 0) * 100) : "—", "engagement / views on filtered sample"),
        metric("Verified authors", xAvailable ? compact(x?.aggregated.verifiedAuthors) : "—", "filtered sample"),
        metric("Verified ratio", xAvailable ? pct(verifiedRatio) : "—", "filtered sample"),
        metric("Influencers", xAvailable ? String(influencers.length) : "—", "verified / ≥10k followers / high-engagement proxy"),
        metric("Potential reach", xAvailable ? compact(reach) : "—", "sum of known follower counts; not unique reach"),
        metric("Influencer reach", xAvailable ? compact(influencerReach) : "—", "sum of known follower counts; not unique reach"),
        metric("Quality accounts (proxy)", xAvailable ? String(qualityAccounts) : "—", "not historical smart-money classification"),
        metric("Repeat shillers", xAvailable ? String(repeatShillers) : "—", "filtered sample"),
        metric("Bot risk", xAvailable ? score(botRisk) : "—", "pre-exclusion risk universe when backend provides it"),
        metric("Bot ratio", xAvailable ? pct(botRatio) : "—", "pre-exclusion risk universe when backend provides it"),
        metric("Bot burst 1h", xAvailable ? pct(botBurst) : "—", "retained top-post sample only"),
        metric("Anomalies", xAvailable ? String(anomalyCount) : "—", "pre-exclusion risk universe when backend provides it"),
        metric("Follower quality", xAvailable ? score(followerQuality) : "—", "coverage-aware heuristic proxy"),
        metric("Sentiment", xAvailable ? xSentiment.label : "—", "deterministic lexicon on retained top posts"),
        metric("Positive", xAvailable ? pct(xSentiment.p) : "—", "retained top-post sample"),
        metric("Neutral", xAvailable ? pct(xSentiment.u) : "—", "retained top-post sample"),
        metric("Negative", xAvailable ? pct(xSentiment.n) : "—", "retained top-post sample"),
        metric("Sentiment change", xAvailable ? signedPct(xSentimentDelta) : "—", "retained sample halves"),
        metric("First mover", xAvailable ? firstXAuthor : "—", "earliest retained X top-post; not guaranteed population origin"),
        metric("First mention", firstX != null ? ago(firstX, now) : "—", "earliest retained X top-post"),
        metric("Account age", "—", "X collector does not expose account creation date"),
      ],
    },
    {
      title: "Telegram",
      rows: [
        metric("TG score", tgAvailable ? score(tgScore) : "—", "coverage-penalized deterministic score"),
        metric("Mentions", tgAvailable ? compact(tgMentions) : "—", tgExactNote),
        metric("Retained messages", tgAvailable ? String(telegramItems.length) : "—", tgRetainedNote),
        metric("Mentions 5m", tgAvailable ? String(tgWindow.m5) : "—", tgRetainedNote),
        metric("Mentions 15m", tgAvailable ? String(tgWindow.m15) : "—", tgRetainedNote),
        metric("Mentions 1h", tgAvailable ? String(tgWindow.h1) : "—", tgRetainedNote),
        metric("Mentions 6h", tgAvailable ? String(tgWindow.h6) : "—", tgRetainedNote),
        metric("Mentions 24h", tgAvailable ? String(tgWindow.h24) : "—", tgRetainedNote),
        metric("Mentions / h", tgAvailable ? tgVelocity.toFixed(2) : "—", "exact filtered count / requested lookback when metadata is available"),
        metric("Acceleration", tgAvailable ? score(tgAcceleration) : "—", "retained timeline only; 50≈stable"),
        metric("Channels", tgAvailable ? String(tgSourceCount) : "—", "exact unique filtered sources before limit when metadata is available"),
        metric("Channels retained", tgAvailable ? String(retainedTgKeys.size) : "—", tgRetainedNote),
        metric("Channels 6h", tgAvailable ? String(tgWindow.unique6) : "—", tgRetainedNote),
        metric("Channels 24h", tgAvailable ? String(tgWindow.unique24) : "—", tgRetainedNote),
        metric("Channel growth 6h", tgAvailable ? signedPct(growthPct(tgWindow.unique6, tgWindow.uniquePrev6)) : "—", "retained timeline vs previous 6h"),
        metric("Explicit calls", tgAvailable ? String(explicitCalls) : "—", "exact before limit when metadata is available"),
        metric("Explicit call share", tgAvailable ? pct(callDensity) : "—", "explicit calls / exact filtered mentions"),
        metric("Channel score", channelScore != null ? score(channelScore) : "—", "weighted by evaluated history where available"),
        metric("Evaluated historical calls", relatedChannels.length ? compact(evaluatedCalls) : "—"),
        metric("Historical win rate", winRate != null ? pct(winRate) : "—", "weighted only by matured evaluated calls"),
        metric("Historical rug rate", rugRate != null ? pct(rugRate) : "—", "weighted only by matured evaluated calls"),
        metric("Sentiment", tgAvailable ? tgSentiment.label : "—", "deterministic lexicon on retained timeline"),
        metric("AI sentiment", aiResult?.sentiment?.label || "—", "separate AI output; does not rewrite deterministic scores"),
        metric("AI sentiment score", aiResult?.sentiment?.score != null ? numberOr(aiResult.sentiment.score).toFixed(2) : "—"),
        metric("AI sentiment confidence", aiResult?.sentiment?.confidence != null ? pct(numberOr(aiResult.sentiment.confidence) * 100) : "—", "raw model confidence"),
        metric("Window sentiment change", tgAvailable ? signedPct(tgSentimentDelta) : "—", "retained timeline"),
        metric("Dominant intent", aiResult?.dominantIntent || "—", "AI-only output"),
        metric("Top/first source", tgAvailable ? firstTgSource : "—", "earliest retained source label"),
        metric("First signal", firstTg != null ? ago(firstTg, now) : "—", tg?.meta?.firstMatchedAt ? "exact first filtered backend event" : "earliest retained event"),
        metric("AI campaign", campaign, "AI-only hypothesis"),
        metric("AI coordination risk", aiResult ? score(aiCoordination) : "—", "AI-only; not part of deterministic manipulation score"),
        metric("AI risk score", aiResult ? score(aiRisk) : "—", "AI-only; not part of deterministic social risk"),
        metric("AI overall confidence", aiResult?.overallConfidence != null ? pct(numberOr(aiResult.overallConfidence) * 100) : "—", "model confidence; not outcome probability"),
      ],
    },
    {
      title: "Growth / Quality / Manipulation",
      rows: [
        metric("Hype score", score(hype), "heuristic from sampled acceleration, sample/exact density and X engagement"),
        metric("FOMO score", score(fomo), "heuristic; not outcome probability"),
        metric("Organic score", score(organic), "deterministic heuristic; independent from Qwen"),
        metric("Paid promotion risk", score(paid), "deterministic proxy; no payment proof"),
        metric("Manipulation score", score(manipulation), "deterministic heuristic; independent from Qwen"),
        metric("Social risk", score(socialRisk), "deterministic heuristic; independent from Qwen"),
        metric("Social risk level", riskLevel),
        metric("Coordination score", score(coordinationScore), "copy/repeat/burst heuristic; not operator identity proof"),
        metric("Copy-paste ratio", pct(copyRatio), "exact-normalized duplicates in retained evidence only"),
        metric("Follower quality", score(followerQuality), "coverage-aware proxy"),
        metric("Narrative strength", aiResult ? score(narrativeStrength) : "—", "AI hypothesis support proxy; separate from deterministic score"),
        metric("Narrative", narrative, "AI-only"),
        metric("Campaign hypothesis", campaign, "AI-only"),
        metric("Peak density", `${Math.max(xVelocity, tgVelocity).toFixed(2)}/h`, "X is sample density; TG is exact filtered density when metadata exists"),
        metric("Velocity change", score(average([xAcceleration, tgAcceleration])), "sample-window heuristic"),
        metric("Sentiment change", signedPct(combinedDelta), "positive-share change inside retained samples"),
      ],
    },
    {
      title: "Cross-platform / Timing",
      rows: [
        metric("Cross-platform score", score(cross), "retained-event temporal alignment within 30m; not based only on first mention"),
        metric("Cross matched share", pct(alignment.matchedShare * 100), "share of retained X/TG events with a counterpart within 30m"),
        metric("Cross median lag", alignment.medianLagMinutes == null ? "—" : `${alignment.medianLagMinutes.toFixed(1)}m`, "median nearest cross-platform lag in retained evidence"),
        metric("Both platforms active", both ? "YES" : "NO"),
        metric("TG → X first lag", firstX != null && firstTg != null && firstTg <= firstX ? `${Math.round((firstX - firstTg) / 60_000)}m` : "—", "first TG may be exact; first X is retained top-post sample"),
        metric("X → TG first lag", firstX != null && firstTg != null && firstX < firstTg ? `${Math.round((firstTg - firstX) / 60_000)}m` : "—", "first X is retained top-post sample"),
        metric("First X", firstX != null ? ago(firstX, now) : "—", "earliest retained X top-post"),
        metric("First TG", firstTg != null ? ago(firstTg, now) : "—", tg?.meta?.firstMatchedAt ? "exact filtered backend origin" : "retained origin"),
        metric("Social spike", spike == null ? "—" : ago(spike, now), "densest retained 5m window; requires ≥3 events"),
        metric("Early signal score", earlyKnown ? score(early) : "—", "pair-relative timing proxy: 100 at/before selected pair creation, decays to 0 by +120m"),
        metric("Early timing delta", earlyMinutes == null ? "—" : `${earlyMinutes >= 0 ? "+" : ""}${earlyMinutes.toFixed(1)}m`, `relative to ${market?.pair?.createdAtSemantics || "selected pair creation timestamp"}`),
        metric("Alpha score", score(alpha), "heuristic composite; not probability of profit"),
        metric("Social score", score(socialScore), "deterministic composite; independent from Qwen"),
        metric("Price ↔ Social direction", direction),
        metric("Lead / lag", leadLag == null ? "—" : `${Math.abs(leadLag).toFixed(1)}m`, "nearest ≥10%/5m price impulse around retained social spike"),
        metric("Lead/lag confidence", score(confidence), "evidence coverage heuristic; not statistical p-value"),
        metric("Price after social 5m", signedPct(r5)),
        metric("Price after social 15m", signedPct(r15)),
        metric("Price after social 1h", signedPct(r60)),
        metric("Max upside 1h", signedPct(maxUp), "from causal price at-or-before social spike"),
        metric("Max drawdown 1h", signedPct(maxDd), "peak-to-subsequent-trough after social spike"),
        metric("Nearest 5m price impulse", impulse ? signedPct(impulse.change) : "—"),
        metric("Price 1h snapshot", signedPct(market?.pair?.changeH1), marketStaleNote),
        metric("Price 24h snapshot", signedPct(market?.pair?.change24h), marketStaleNote),
        metric("Volume 1h", money(market?.pair?.volumeH1), marketStaleNote),
        metric("Volume 24h", money(market?.pair?.volumeH24), marketStaleNote),
        metric("Liquidity", money(market?.pair?.liquidityUsd), marketStaleNote),
      ],
    },
    {
      title: "Price event evidence",
      rows: [
        metric("Trades sampled", chain ? compact(trades.length) : "—", chain?.truncated ? "history truncated" : "returned trade history"),
        metric("Trade history start", trades.length ? ago(trades[0].time, now) : "—"),
        metric("Trade history end", trades.length ? ago(trades[trades.length - 1].time, now) : "—"),
        metric("Price at social spike", p0 ? p0.price.toPrecision(6) : "—", "last trade at-or-before spike within 5m; SOL/token"),
        metric("Price +5m", p5 ? p5.price.toPrecision(6) : "—", "first trade at/after target within 5m"),
        metric("Price +15m", p15 ? p15.price.toPrecision(6) : "—", "first trade at/after target within 5m"),
        metric("Price +1h", p60 ? p60.price.toPrecision(6) : "—", "first trade at/after target within 10m"),
        metric("Impulse timestamp", impulse ? ago(impulse.time, now) : "—"),
        metric("Impulse threshold", `${IMPULSE_THRESHOLD_PCT}% / ${IMPULSE_WINDOW_MS / 60_000}m`),
        metric("On-chain raw trades", compact(chain?.summary?.totalRawTrades ?? chain?.summary?.totalTrades)),
        metric("Unique wallets", compact(chain?.summary?.uniqueWallets)),
        metric("Wallets enriched", chain ? String(chain.wallets?.length || 0) : "—"),
        metric("Synchronous buy clusters", chain ? String(chain.bundles?.length || 0) : "—", "heuristic 5s/±5% amount clusters; not atomic bundle proof"),
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
        metric("AI coordination risk", aiResult ? score(aiCoordination) : "—", "AI-only evidence class"),
        metric("AI risk score", aiResult ? score(aiRisk) : "—", "AI-only evidence class"),
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
