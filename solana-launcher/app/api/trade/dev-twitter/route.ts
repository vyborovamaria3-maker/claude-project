// data-tag: api.trade.dev_twitter
// GET /api/trade/dev-twitter?symbol=...&mint=...
// X collector contract separates risk-universe statistics from display filters.

import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import {
  buildQuery,
  fetchTokenMeta,
  hasTwitterAuth,
  normalizeTwitterHandle,
  scrapeTwitter,
  type CollectionStrategy,
} from "../../../../lib/trade/twitter-scraper";
import { getDb } from "../../../../lib/trade/db";
import { getTokenTwitterSocialStats } from "../../../../lib/twitterSocialStats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE = new Map<string, { data: TwitterStats; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export interface TwitterRiskUniverse {
  totalTweets: number;
  uniqueAuthors: number;
  suspiciousTweets: number;
  botAccounts: number;
  botRiskScore: number;
  botRatio: number;
  anomalyCount: number;
}

export interface TwitterStats {
  symbol: string;
  mint: string;
  twitterHandle: string | null;
  totalTweets: number;
  totalViews: number;
  totalLikes: number;
  totalRetweets: number;
  uniqueMentioners: number;
  botRisk: "low" | "medium" | "high";
  botRiskScore: number;
  anomalyCount: number;
  riskUniverse: TwitterRiskUniverse;
  collectionTruncated: boolean;
  sampleLimit: number;
  meta: {
    scraped: number;
    matchedBeforeLimit: number;
    returned: number;
    truncated: boolean;
    queryMode: "top";
    suspiciousExcluded: boolean;
    verifiedOnly: boolean;
    authenticatedBrowser: boolean;
    coverageConfirmed: boolean;
  };
  topTweets: TweetData[];
  shillers: ShillerEntry[];
  lastUpdated: number;
  avgViews: number;
  avgLikes: number;
  avgRetweets: number;
  tokenAccount: TokenAccount | null;
  collectionStrategy: string;
  performance: {
    responseTimeMs: number;
    cached: boolean;
  };
  aggregated: {
    totalTweets: number;
    totalViews: number;
    totalLikes: number;
    totalRetweets: number;
    totalEngagement: number;
    engagementRate: number;
    avgViews: number;
    avgLikes: number;
    avgRetweets: number;
    uniqueAuthors: number;
    verifiedAuthors: number;
    botSuspectedCount: number;
    botRatio: number;
  };
  topByViews: TweetData[];
  topByLikes: TweetData[];
  topByRetweets: TweetData[];
  topByEngagement: TweetData[];
  discovery: {
    mentions: number;
    accounts: number;
    memecoinAccounts: number;
    firstAccountCreatedAt: number | null;
    lastDiscoveredAt: number | null;
  };
}

export interface TokenAccount {
  handle: string;
  displayName: string | null;
  followers: number | null;
  postsCount: number | null;
  isVerified: boolean;
}

export interface TweetData {
  id: string;
  text: string;
  author: string;
  likes: number;
  retweets: number;
  views: number;
  timestamp: number | null;
  isSuspicious: boolean;
}

export interface ShillerEntry {
  handle: string;
  tweets: number;
  totalEngagement: number;
  isBot: boolean;
  followers: number | null;
  postsCount: number | null;
  isVerified: boolean;
}

function parseInteger(value: string | null, fallback: number, min: number, max: number) {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function parseOptionalHours(value: string | null): number | null {
  if (value == null || value.trim() === "" || value === "all" || value === "0") return null;
  return parseInteger(value, 24, 1, 8760);
}

function parseBoolean(value: string | null, fallback = false) {
  if (value == null) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function isSolanaMint(value: string) {
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

function tweetEngagement(tweet: { likes: number; retweets: number; replies: number }) {
  return Math.max(tweet.likes || 0, 0)
    + Math.max(tweet.retweets || 0, 0)
    + Math.max(tweet.replies || 0, 0);
}

type TwitterScrapeResult = Awaited<ReturnType<typeof scrapeTwitter>>;
type AnalyzedTweet = TwitterScrapeResult["tweets"][number] & {
  isSuspicious?: boolean;
  suspicionScore?: number;
  suspicionReasons?: string[];
};
type AnalyzedAccount = TwitterScrapeResult["accounts"] extends Map<string, infer T>
  ? T & {
      botScore?: number;
      isBot?: boolean;
      isSubscriptionPromoter?: boolean;
      botReasons?: string[];
    }
  : never;

function persistTwitterStats(
  stats: TwitterStats,
  query: string,
  tweets: TwitterScrapeResult["tweets"],
  accounts: TwitterScrapeResult["accounts"],
  excludedHandles: Set<string>,
) {
  const db = getDb();
  const now = stats.lastUpdated;
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO twitter_token_analyses
         (mint, symbol, token_twitter_handle, query, total_tweets, total_views, total_likes,
          total_retweets, unique_accounts, verified_accounts, bot_accounts, excluded_bot_accounts,
          avg_views, avg_likes, avg_retweets, bot_manipulation_score, bot_manipulation_risk, analyzed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      stats.mint,
      stats.symbol,
      stats.twitterHandle,
      query,
      stats.totalTweets,
      stats.totalViews,
      stats.totalLikes,
      stats.totalRetweets,
      stats.uniqueMentioners,
      stats.aggregated.verifiedAuthors,
      stats.riskUniverse.botAccounts,
      excludedHandles.size,
      stats.avgViews,
      stats.avgLikes,
      stats.avgRetweets,
      stats.botRiskScore,
      stats.botRisk,
      now,
    );

    const tweetStmt = db.prepare(
      `INSERT INTO twitter_token_tweets
         (tweet_id, mint, symbol, author_handle, text, url, views, likes, retweets, replies,
          is_verified, is_suspicious, suspicion_score, suspicion_reasons, posted_at, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tweet_id) DO UPDATE SET
         mint = excluded.mint,
         symbol = excluded.symbol,
         author_handle = excluded.author_handle,
         text = excluded.text,
         url = excluded.url,
         views = excluded.views,
         likes = excluded.likes,
         retweets = excluded.retweets,
         replies = excluded.replies,
         is_verified = excluded.is_verified,
         is_suspicious = excluded.is_suspicious,
         suspicion_score = excluded.suspicion_score,
         suspicion_reasons = excluded.suspicion_reasons,
         posted_at = excluded.posted_at,
         fetched_at = excluded.fetched_at`,
    );
    for (const tweet of tweets) {
      const analyzed = tweet as AnalyzedTweet;
      tweetStmt.run(
        tweet.id,
        stats.mint,
        stats.symbol,
        tweet.authorHandle,
        tweet.text,
        tweet.url,
        tweet.views,
        tweet.likes,
        tweet.retweets,
        tweet.replies,
        tweet.isVerified ? 1 : 0,
        analyzed.isSuspicious ? 1 : 0,
        analyzed.suspicionScore ?? 0,
        JSON.stringify(analyzed.suspicionReasons ?? []),
        tweet.postedAt,
        now,
      );
    }

    const accountStmt = db.prepare(
      `INSERT INTO twitter_accounts
         (handle, display_name, followers, following, posts_count, is_verified, first_seen_at,
          last_seen_at, bot_score, is_bot, is_subscription_promoter, bot_reasons)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(handle) DO UPDATE SET
         display_name = COALESCE(excluded.display_name, twitter_accounts.display_name),
         followers = COALESCE(excluded.followers, twitter_accounts.followers),
         following = COALESCE(excluded.following, twitter_accounts.following),
         posts_count = COALESCE(excluded.posts_count, twitter_accounts.posts_count),
         is_verified = MAX(excluded.is_verified, twitter_accounts.is_verified),
         last_seen_at = excluded.last_seen_at,
         bot_score = MAX(excluded.bot_score, twitter_accounts.bot_score),
         is_bot = MAX(excluded.is_bot, twitter_accounts.is_bot),
         is_subscription_promoter = MAX(excluded.is_subscription_promoter, twitter_accounts.is_subscription_promoter),
         bot_reasons = excluded.bot_reasons`,
    );
    const shillerStmt = db.prepare(
      `INSERT INTO twitter_token_shillers
         (mint, handle, tweets_count, total_views, total_likes, total_retweets, avg_views,
          avg_likes, avg_retweets, is_verified, is_bot, is_excluded, first_tweeted_at, last_tweeted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(mint, handle) DO UPDATE SET
         tweets_count = excluded.tweets_count,
         total_views = excluded.total_views,
         total_likes = excluded.total_likes,
         total_retweets = excluded.total_retweets,
         avg_views = excluded.avg_views,
         avg_likes = excluded.avg_likes,
         avg_retweets = excluded.avg_retweets,
         is_verified = excluded.is_verified,
         is_bot = excluded.is_bot,
         is_excluded = excluded.is_excluded,
         first_tweeted_at = excluded.first_tweeted_at,
         last_tweeted_at = excluded.last_tweeted_at`,
    );

    for (const account of accounts.values()) {
      const analyzed = account as AnalyzedAccount;
      accountStmt.run(
        account.handle,
        account.displayName,
        account.followers,
        account.following,
        account.postsCount,
        account.isVerified ? 1 : 0,
        account.firstTweetedAt ?? now,
        now,
        analyzed.botScore ?? 0,
        analyzed.isBot ? 1 : 0,
        analyzed.isSubscriptionPromoter ? 1 : 0,
        JSON.stringify(analyzed.botReasons ?? []),
      );
      shillerStmt.run(
        stats.mint,
        account.handle,
        account.tweetsCount,
        account.totalViews,
        account.totalLikes,
        account.totalRetweets,
        account.tweetsCount > 0 ? account.totalViews / account.tweetsCount : 0,
        account.tweetsCount > 0 ? account.totalLikes / account.tweetsCount : 0,
        account.tweetsCount > 0 ? account.totalRetweets / account.tweetsCount : 0,
        account.isVerified ? 1 : 0,
        analyzed.isBot ? 1 : 0,
        excludedHandles.has(account.handle) ? 1 : 0,
        account.firstTweetedAt,
        account.lastTweetedAt,
      );
    }
  });
  tx();
}

export async function GET(req: NextRequest) {
  const mint = req.nextUrl.searchParams.get("mint") || "";
  const symbolParam = (req.nextUrl.searchParams.get("symbol") || "").trim().replace(/^\$/, "");
  const strategyParam = req.nextUrl.searchParams.get("strategy") || "auto";
  const providedHandle = normalizeTwitterHandle(req.nextUrl.searchParams.get("twitter"));
  const scopeParam = req.nextUrl.searchParams.get("scope") || "mentions";
  const limit = parseInteger(req.nextUrl.searchParams.get("limit"), 20, 5, 100);
  const lookbackHours = parseOptionalHours(req.nextUrl.searchParams.get("hours"));
  const minEngagement = parseInteger(req.nextUrl.searchParams.get("minEngagement"), 0, 0, 1_000_000_000);
  const verifiedOnly = parseBoolean(req.nextUrl.searchParams.get("verifiedOnly"));
  const excludeSuspicious = parseBoolean(req.nextUrl.searchParams.get("excludeSuspicious"));

  if (!mint) return NextResponse.json({ error: "mint required" }, { status: 400 });
  if (!isSolanaMint(mint)) return NextResponse.json({ error: "invalid Solana mint" }, { status: 400 });
  if (!["nitter", "playwright", "auto"].includes(strategyParam)) {
    return NextResponse.json({ error: "strategy must be one of: nitter, playwright, auto" }, { status: 400 });
  }
  if (!["mentions", "official"].includes(scopeParam)) {
    return NextResponse.json({ error: "scope must be one of: mentions, official" }, { status: 400 });
  }
  if (symbolParam && !/^[A-Za-z0-9_]{1,32}$/.test(symbolParam)) {
    return NextResponse.json({ error: "symbol contains unsupported characters" }, { status: 400 });
  }
  if (providedHandle && !/^[A-Za-z0-9_]{1,30}$/.test(providedHandle)) {
    return NextResponse.json({ error: "invalid X handle" }, { status: 400 });
  }

  const requestedStrategy = strategyParam as CollectionStrategy;
  const authenticatedBrowser = hasTwitterAuth();
  if (verifiedOnly && requestedStrategy === "nitter") {
    return NextResponse.json(
      { error: "verifiedOnly requires Playwright/X browser session; Nitter does not expose verification reliably" },
      { status: 400 },
    );
  }
  if (verifiedOnly && !authenticatedBrowser) {
    return NextResponse.json(
      { error: "verifiedOnly requires an authenticated X browser session" },
      { status: 409 },
    );
  }
  const strategy: CollectionStrategy = verifiedOnly && requestedStrategy === "auto" ? "playwright" : requestedStrategy;
  const scope = scopeParam as "mentions" | "official";
  const cacheKey = [
    mint,
    symbolParam,
    strategy,
    scope,
    providedHandle || "",
    limit,
    lookbackHours ?? "all",
    minEngagement,
    verifiedOnly ? 1 : 0,
    excludeSuspicious ? 1 : 0,
    authenticatedBrowser ? "auth" : "public",
  ].join(":");
  const cached = CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return NextResponse.json({
      ...cached.data,
      performance: { ...cached.data.performance, responseTimeMs: 0, cached: true },
    });
  }

  const meta = providedHandle && symbolParam ? null : await fetchTokenMeta(mint);
  const symbol = symbolParam || meta?.symbol || mint.slice(0, 6);
  const twitterHandle = providedHandle || normalizeTwitterHandle(meta?.twitter);
  const query = buildQuery({ mint, symbol, tokenTwitterHandle: twitterHandle, scope });
  if (!query) {
    return NextResponse.json(
      { error: scope === "official" ? "official twitter handle not found" : "could not build search query" },
      { status: 400 },
    );
  }

  let result: TwitterScrapeResult;
  const needsOverscan = verifiedOnly || excludeSuspicious || minEngagement > 0 || lookbackHours != null;
  const scrapeLimit = Math.min(100, needsOverscan ? Math.max(limit * 2, 20) : limit);
  try {
    result = await scrapeTwitter(query, { limit: scrapeLimit, headless: true, strategy });
  } catch (error) {
    console.error("Twitter scrape error:", error);
    const message = error instanceof Error ? error.message : "failed to scrape twitter";
    return NextResponse.json({ error: message }, { status: 503 });
  }

  if (result.tweets.length === 0 && result.strategy === "nitter" && !authenticatedBrowser) {
    return NextResponse.json(
      { error: "X collector unavailable: public mirror returned no data and no authenticated browser session exists. Run npm run x:login." },
      { status: 503 },
    );
  }

  const cutoff = lookbackHours == null ? null : Date.now() - lookbackHours * HOUR_MS;
  const riskTweets = result.tweets.filter((tweet) => {
    if (cutoff != null && (tweet.postedAt == null || tweet.postedAt < cutoff)) return false;
    if (tweetEngagement(tweet) < minEngagement) return false;
    if (verifiedOnly && !tweet.isVerified) return false;
    return true;
  });
  const riskHandles = new Set(riskTweets.map((tweet) => tweet.authorHandle));
  const suspiciousRiskTweets = riskTweets.filter((tweet) => Boolean((tweet as AnalyzedTweet).isSuspicious));
  const botRiskHandles = new Set(
    [...riskHandles].filter((handle) => {
      const account = result.accounts.get(handle) as AnalyzedAccount | undefined;
      return Boolean(account?.isBot);
    }),
  );
  const botRiskScore = riskTweets.length || riskHandles.size
    ? Math.round(
        (suspiciousRiskTweets.length / Math.max(riskTweets.length, 1)) * 50
        + (botRiskHandles.size / Math.max(riskHandles.size, 1)) * 50,
      )
    : 0;
  const botRisk: "low" | "medium" | "high" = botRiskScore >= 65 ? "high" : botRiskScore >= 35 ? "medium" : "low";
  const riskUniverse: TwitterRiskUniverse = {
    totalTweets: riskTweets.length,
    uniqueAuthors: riskHandles.size,
    suspiciousTweets: suspiciousRiskTweets.length,
    botAccounts: botRiskHandles.size,
    botRiskScore,
    botRatio: riskHandles.size ? botRiskHandles.size / riskHandles.size : 0,
    anomalyCount: suspiciousRiskTweets.length,
  };

  const displayEligible = riskTweets.filter((tweet) => {
    if (!excludeSuspicious) return true;
    const analyzed = tweet as AnalyzedTweet;
    const account = result.accounts.get(tweet.authorHandle) as AnalyzedAccount | undefined;
    return !analyzed.isSuspicious && !account?.isBot;
  });
  const displayEligibleHandles = new Set(displayEligible.map((tweet) => tweet.authorHandle));
  // Persist exclusion only when filtering actually removed every eligible row for
  // an author. The display limit must never turn normal authors into "excluded".
  const excludedHandles = new Set(
    [...riskHandles].filter((handle) => !displayEligibleHandles.has(handle)),
  );
  const filteredTweets = displayEligible.slice(0, limit);

  const authorAggregates = new Map<string, {
    tweets: number;
    engagement: number;
    views: number;
    likes: number;
    retweets: number;
    firstTweetedAt: number | null;
    lastTweetedAt: number | null;
  }>();
  for (const tweet of filteredTweets) {
    const current = authorAggregates.get(tweet.authorHandle) || {
      tweets: 0,
      engagement: 0,
      views: 0,
      likes: 0,
      retweets: 0,
      firstTweetedAt: null,
      lastTweetedAt: null,
    };
    current.tweets += 1;
    current.engagement += tweetEngagement(tweet);
    current.views += tweet.views || 0;
    current.likes += tweet.likes || 0;
    current.retweets += tweet.retweets || 0;
    if (tweet.postedAt != null) {
      current.firstTweetedAt = Math.min(current.firstTweetedAt ?? Infinity, tweet.postedAt);
      current.lastTweetedAt = Math.max(current.lastTweetedAt ?? 0, tweet.postedAt);
    }
    authorAggregates.set(tweet.authorHandle, current);
  }

  const filteredAccounts: TwitterScrapeResult["accounts"] = new Map();
  for (const [handle, aggregate] of authorAggregates) {
    const account = result.accounts.get(handle);
    if (!account) continue;
    filteredAccounts.set(handle, {
      ...account,
      tweetsCount: aggregate.tweets,
      totalViews: aggregate.views,
      totalLikes: aggregate.likes,
      totalRetweets: aggregate.retweets,
      firstTweetedAt: aggregate.firstTweetedAt,
      lastTweetedAt: aggregate.lastTweetedAt,
    });
  }

  const topTweets: TweetData[] = filteredTweets.map((tweet) => ({
    id: tweet.id,
    text: tweet.text,
    author: tweet.authorHandle,
    likes: tweet.likes,
    retweets: tweet.retweets,
    views: tweet.views,
    timestamp: tweet.postedAt,
    isSuspicious: Boolean((tweet as AnalyzedTweet).isSuspicious),
  }));
  const shillers: ShillerEntry[] = Array.from(authorAggregates.entries())
    .map(([handle, aggregate]) => {
      const account = filteredAccounts.get(handle) as AnalyzedAccount | undefined;
      return {
        handle,
        tweets: aggregate.tweets,
        totalEngagement: aggregate.engagement,
        isBot: Boolean(account?.isBot),
        followers: account?.followers ?? null,
        postsCount: account?.postsCount ?? null,
        isVerified: Boolean(account?.isVerified),
      };
    })
    .sort((left, right) => right.totalEngagement - left.totalEngagement)
    .slice(0, 30);

  const tokenAccount = twitterHandle ? result.accounts.get(twitterHandle) : null;
  const tokenAccountData: TokenAccount | null = tokenAccount
    ? {
        handle: tokenAccount.handle,
        displayName: tokenAccount.displayName,
        followers: tokenAccount.followers,
        postsCount: tokenAccount.postsCount,
        isVerified: tokenAccount.isVerified,
      }
    : null;

  const totalViews = filteredTweets.reduce((sum, tweet) => sum + tweet.views, 0);
  const totalLikes = filteredTweets.reduce((sum, tweet) => sum + tweet.likes, 0);
  const totalRetweets = filteredTweets.reduce((sum, tweet) => sum + tweet.retweets, 0);
  const totalEngagement = filteredTweets.reduce((sum, tweet) => sum + tweetEngagement(tweet), 0);
  const verifiedAuthors = [...authorAggregates.keys()].filter((handle) => Boolean(filteredAccounts.get(handle)?.isVerified)).length;
  const displayBotAuthors = [...authorAggregates.keys()].filter((handle) => {
    const account = filteredAccounts.get(handle) as AnalyzedAccount | undefined;
    return Boolean(account?.isBot);
  }).length;
  const engagementRate = totalViews > 0 ? totalEngagement / totalViews : 0;
  const avgViews = filteredTweets.length ? Math.round(totalViews / filteredTweets.length) : 0;
  const avgLikes = filteredTweets.length ? Math.round(totalLikes / filteredTweets.length) : 0;
  const avgRetweets = filteredTweets.length ? Math.round(totalRetweets / filteredTweets.length) : 0;
  const collectionTruncated = result.tweets.length >= scrapeLimit || displayEligible.length > limit;

  const stats: TwitterStats = {
    symbol,
    mint,
    twitterHandle: twitterHandle ?? null,
    totalTweets: filteredTweets.length,
    totalViews,
    totalLikes,
    totalRetweets,
    uniqueMentioners: authorAggregates.size,
    botRisk,
    botRiskScore,
    anomalyCount: riskUniverse.anomalyCount,
    riskUniverse,
    collectionTruncated,
    sampleLimit: limit,
    meta: {
      scraped: result.tweets.length,
      matchedBeforeLimit: displayEligible.length,
      returned: filteredTweets.length,
      truncated: collectionTruncated,
      queryMode: "top",
      suspiciousExcluded: excludeSuspicious,
      verifiedOnly,
      authenticatedBrowser,
      coverageConfirmed: result.strategy === "playwright" || result.tweets.length > 0,
    },
    topTweets,
    shillers,
    lastUpdated: Date.now(),
    avgViews,
    avgLikes,
    avgRetweets,
    tokenAccount: tokenAccountData,
    collectionStrategy: result.strategy,
    performance: result.performance,
    aggregated: {
      totalTweets: filteredTweets.length,
      totalViews,
      totalLikes,
      totalRetweets,
      totalEngagement,
      engagementRate,
      avgViews,
      avgLikes,
      avgRetweets,
      uniqueAuthors: authorAggregates.size,
      verifiedAuthors,
      botSuspectedCount: displayBotAuthors,
      botRatio: authorAggregates.size ? displayBotAuthors / authorAggregates.size : 0,
    },
    topByViews: [...topTweets].sort((left, right) => right.views - left.views).slice(0, 5),
    topByLikes: [...topTweets].sort((left, right) => right.likes - left.likes).slice(0, 5),
    topByRetweets: [...topTweets].sort((left, right) => right.retweets - left.retweets).slice(0, 5),
    topByEngagement: [...topTweets]
      .sort((left, right) => (right.likes + right.retweets) - (left.likes + left.retweets))
      .slice(0, 5),
    discovery: {
      mentions: filteredTweets.length,
      accounts: authorAggregates.size,
      memecoinAccounts: shillers.length,
      firstAccountCreatedAt: null,
      lastDiscoveredAt: filteredTweets.reduce<number | null>((latest, tweet) => {
        if (tweet.timestamp == null) return latest;
        return latest == null ? tweet.timestamp : Math.max(latest, tweet.timestamp);
      }, null),
    },
  };

  try {
    persistTwitterStats(stats, query, filteredTweets, filteredAccounts, excludedHandles);
  } catch (error) {
    console.warn("Twitter persistence error:", error);
  }

  try {
    const localStats = getTokenTwitterSocialStats(mint);
    if (localStats) {
      stats.discovery.mentions = Math.max(stats.discovery.mentions, Number(localStats.mentions || 0));
      stats.discovery.accounts = Math.max(stats.discovery.accounts, Number(localStats.accounts || 0));
    }
  } catch {
    // Optional local enrichment must never fail the live endpoint.
  }

  CACHE.set(cacheKey, { data: stats, ts: Date.now() });
  return NextResponse.json(stats);
}
