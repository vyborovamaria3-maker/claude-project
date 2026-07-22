// data-tag: api.trade.dev_twitter
// GET /api/trade/dev-twitter?symbol=...&mint=...
// Aggregates Twitter/X mentions via Playwright with authenticated session
// Uses pump.fun token metadata + Playwright scraping for full metrics

import { NextRequest, NextResponse } from "next/server";
import { scrapeTwitter, fetchTokenMeta, buildQuery, normalizeTwitterHandle, type CollectionStrategy } from "../../../../lib/trade/twitter-scraper";
import { getDb } from "../../../../lib/trade/db";
import { getTokenTwitterSocialStats } from "../../../../lib/twitterSocialStats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE: Map<string, { data: TwitterStats; ts: number }> = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 min

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
  botRiskScore: number; // 0-100
  anomalyCount: number;
  topTweets: TweetData[];
  shillers: ShillerEntry[];
  lastUpdated: number;
  // New fields with full metrics
  avgViews: number;
  avgLikes: number;
  avgRetweets: number;
  tokenAccount: TokenAccount | null;
  // Aggregated stats from spec
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
  timestamp: number;
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

function persistTwitterStats(stats: TwitterStats, query: string, rawResult: Awaited<ReturnType<typeof scrapeTwitter>>) {
  const db = getDb();
  const now = stats.lastUpdated;
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO twitter_token_analyses
         (mint, symbol, token_twitter_handle, query, total_tweets, total_views, total_likes,
          total_retweets, unique_accounts, verified_accounts, bot_accounts, excluded_bot_accounts,
          avg_views, avg_likes, avg_retweets, bot_manipulation_score, bot_manipulation_risk, analyzed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      stats.aggregated.botSuspectedCount,
      0,
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
         fetched_at = excluded.fetched_at`
    );

    for (const tweet of rawResult.tweets) {
      const analyzed = tweet as typeof tweet & { isSuspicious?: boolean; suspicionScore?: number; suspicionReasons?: string[] };
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
         bot_reasons = excluded.bot_reasons`
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
         last_tweeted_at = excluded.last_tweeted_at`
    );

    for (const account of rawResult.accounts.values()) {
      const analyzed = account as typeof account & { botScore?: number; isBot?: boolean; isSubscriptionPromoter?: boolean; botReasons?: string[] };
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
        0,
        account.firstTweetedAt,
        account.lastTweetedAt,
      );
    }
  });

  tx();
}

export async function GET(req: NextRequest) {
  const mint = req.nextUrl.searchParams.get("mint") || "";
  const symbolParam = req.nextUrl.searchParams.get("symbol") || "";
  const strategyParam = req.nextUrl.searchParams.get("strategy") || "auto";
  const providedHandle = normalizeTwitterHandle(req.nextUrl.searchParams.get("twitter"));
  const scopeParam = req.nextUrl.searchParams.get("scope") || "mentions";

  if (!mint) return NextResponse.json({ error: "mint required" }, { status: 400 });

  if (!["nitter", "playwright", "auto"].includes(strategyParam)) {
    return NextResponse.json({ error: "strategy must be one of: nitter, playwright, auto" }, { status: 400 });
  }
  if (!["mentions", "official"].includes(scopeParam)) {
    return NextResponse.json({ error: "scope must be one of: mentions, official" }, { status: 400 });
  }
  const strategy = strategyParam as CollectionStrategy;
  const scope = scopeParam as "mentions" | "official";

  const cacheKey = `${mint}:${symbolParam}:${strategy}:${scope}:${providedHandle || ""}`;
  const cached = CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return NextResponse.json({
      ...cached.data,
      performance: {
        ...cached.data.performance,
        responseTimeMs: 0,
        cached: true,
      },
    });
  }

  // Fetch token metadata to get Twitter handle
  const meta = providedHandle && symbolParam ? null : await fetchTokenMeta(mint);
  const symbol = meta?.symbol || symbolParam || mint.slice(0, 6);
  const twitterHandle = providedHandle || normalizeTwitterHandle(meta?.twitter);

  // Build search query
  const query = buildQuery({ mint, symbol, tokenTwitterHandle: twitterHandle, scope });

  if (!query) {
    return NextResponse.json({ error: scope === "official" ? "official twitter handle not found" : "could not build search query" }, { status: 400 });
  }

  let result;
  try {
    result = await scrapeTwitter(query, { limit: 20, headless: true, strategy });
  } catch (e) {
    console.error("Twitter scrape error:", e);
    return NextResponse.json({ error: "failed to scrape twitter" }, { status: 500 });
  }

  // Convert scraper data to API format
  const topTweets: TweetData[] = result.tweets.slice(0, 10).map((t) => ({
    id: t.id,
    text: t.text,
    author: t.authorHandle,
    likes: t.likes,
    retweets: t.retweets,
    views: t.views,
    timestamp: t.postedAt || Date.now(),
    isSuspicious: (t as any).isSuspicious || false,
  }));

  const shillers: ShillerEntry[] = Array.from(result.accounts.values())
    .map((acc) => ({
      handle: acc.handle,
      tweets: acc.tweetsCount,
      totalEngagement: acc.totalLikes + acc.totalRetweets,
      isBot: (acc as any).isBot || false,
      followers: acc.followers,
      postsCount: acc.postsCount,
      isVerified: acc.isVerified,
    }))
    .sort((a, b) => b.totalEngagement - a.totalEngagement)
    .slice(0, 30);

  // Find token account if twitterHandle exists
  const tokenAccount = twitterHandle ? result.accounts.get(twitterHandle) : null;
  const tokenAccountData: TokenAccount | null = tokenAccount ? {
    handle: tokenAccount.handle,
    displayName: tokenAccount.displayName,
    followers: tokenAccount.followers,
    postsCount: tokenAccount.postsCount,
    isVerified: tokenAccount.isVerified,
  } : null;

  const anomalyCount = result.tweets.filter((t) => (t as any).isSuspicious).length;
  const botSuspectedCount = result.tweets.filter((t) => (t as any).isSuspicious).length;
  const botRatio = result.tweets.length > 0 ? botSuspectedCount / result.tweets.length : 0;
  const totalEngagement = result.totalLikes + result.totalRetweets;
  const engagementRate = result.totalViews > 0 ? totalEngagement / result.totalViews : 0;
  const byViews = [...topTweets].sort((a, b) => b.views - a.views).slice(0, 5);
  const byLikes = [...topTweets].sort((a, b) => b.likes - a.likes).slice(0, 5);
  const byRetweets = [...topTweets].sort((a, b) => b.retweets - a.retweets).slice(0, 5);
  const byEngagement = [...topTweets].sort((a, b) => (b.likes + b.retweets) - (a.likes + a.retweets)).slice(0, 5);

  const stats: TwitterStats = {
    symbol,
    mint,
    twitterHandle: twitterHandle ?? null,
    totalTweets: result.tweets.length,
    totalViews: result.totalViews,
    totalLikes: result.totalLikes,
    totalRetweets: result.totalRetweets,
    uniqueMentioners: result.uniqueAccounts,
    botRisk: result.botRisk,
    botRiskScore: result.botScore,
    anomalyCount,
    topTweets,
    shillers,
    lastUpdated: Date.now(),
    avgViews: result.tweets.length > 0 ? Math.round(result.totalViews / result.tweets.length) : 0,
    avgLikes: result.tweets.length > 0 ? Math.round(result.totalLikes / result.tweets.length) : 0,
    avgRetweets: result.tweets.length > 0 ? Math.round(result.totalRetweets / result.tweets.length) : 0,
    tokenAccount: tokenAccountData,
    collectionStrategy: result.strategy,
    performance: result.performance,
    aggregated: {
      totalTweets: result.tweets.length,
      totalViews: result.totalViews,
      totalLikes: result.totalLikes,
      totalRetweets: result.totalRetweets,
      totalEngagement,
      engagementRate,
      avgViews: result.tweets.length > 0 ? Math.round(result.totalViews / result.tweets.length) : 0,
      avgLikes: result.tweets.length > 0 ? Math.round(result.totalLikes / result.tweets.length) : 0,
      avgRetweets: result.tweets.length > 0 ? Math.round(result.totalRetweets / result.tweets.length) : 0,
      uniqueAuthors: result.uniqueAccounts,
      verifiedAuthors: result.verifiedAccounts,
      botSuspectedCount,
      botRatio,
    },
    topByViews: byViews,
    topByLikes: byLikes,
    topByRetweets: byRetweets,
    topByEngagement: byEngagement,
    discovery: getTokenTwitterSocialStats(mint),
  };

  persistTwitterStats(stats, query, result);
  CACHE.set(cacheKey, { data: stats, ts: Date.now() });
  return NextResponse.json(stats);
}
