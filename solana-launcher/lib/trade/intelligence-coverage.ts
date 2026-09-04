import type {
  ChainAnalysis,
  Market,
  SocialTimeline,
  TwitterStats,
} from "./social-intelligence";

function timestamp(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function hasXIntelligence(x: TwitterStats | null) {
  if (!x) return false;
  const total = x.riskUniverse?.totalTweets ?? x.totalTweets ?? 0;
  const unique = x.riskUniverse?.uniqueAuthors ?? x.uniqueMentioners ?? 0;
  return total > 0
    || unique > 0
    || (x.topTweets?.length || 0) > 0
    || (x.shillers?.length || 0) > 0;
}

export function telegramEvidenceCount(tg: SocialTimeline | null) {
  if (!tg) return 0;
  const retained = (tg.timeline || []).filter(
    (item) => !item.platform || item.platform.toLowerCase() === "telegram",
  ).length;
  const matched = tg.meta?.matchedPlatforms?.telegram
    ?? tg.meta?.matchedBeforeLimit
    ?? tg.platforms?.telegram
    ?? tg.mentions
    ?? 0;
  return Math.max(retained, Number(matched) || 0);
}

export function hasTelegramIntelligence(tg: SocialTimeline | null) {
  return telegramEvidenceCount(tg) > 0;
}

export function hasChainIntelligence(chain: ChainAnalysis | null) {
  if (!chain) return false;
  return (chain.wallets?.length || 0) > 0
    || (chain.trades?.length || 0) > 0
    || (chain.bundles?.length || 0) > 0
    || (chain.summary?.totalTrades || 0) > 0
    || (chain.summary?.totalRawTrades || 0) > 0
    || (chain.summary?.uniqueWallets || 0) > 0;
}

export function hasFreshMarket(market: Market | null) {
  return Boolean(market?.pair && market.meta?.stale !== true);
}

export function hasEarlyTimingEvidence(
  x: TwitterStats | null,
  tg: SocialTimeline | null,
  market: Market | null,
) {
  if (timestamp(market?.pair?.createdAt) == null) return false;

  const xHasTimestamp = (x?.topTweets || []).some(
    (tweet) => timestamp(tweet.timestamp) != null,
  );
  if (xHasTimestamp) return true;

  if (timestamp(tg?.meta?.firstMatchedAt) != null) return true;
  return (tg?.timeline || []).some(
    (item) => (!item.platform || item.platform.toLowerCase() === "telegram")
      && timestamp(item.occurred_at) != null,
  );
}
