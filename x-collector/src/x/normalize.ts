import type { XTweet } from "./types";

/**
 * XTweet → формат существующей таблицы twitter_tweets.
 * Совместим с TweetSchema из lib/trade/schemas.ts (валидация в worker persistTweets).
 * Без id или с пустым text — null (skip).
 * collected_at — информационное поле: сам INSERT пишет first_seen_at/updated_at.
 */
export interface NormalizedTweet {
  id: string;
  text: string;
  authorHandle: string;
  authorId?: string | null;
  authorDisplayName: null;
  url: string;
  views: number | null;
  likes: number | null;
  retweets: number | null;
  replies: number | null;
  isVerified: boolean;
  postedAt: number | null;
  collectedAt: number;
}

function nonNegative(n: number | null): number | null {
  if (n === null || !Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

export function normalizeTweet(tweet: XTweet): NormalizedTweet | null {
  if (!tweet.id || !tweet.text.trim()) return null;
  return {
    id: tweet.id,
    text: tweet.text,
    authorHandle: tweet.author,
    authorId: tweet.authorId ?? null,
    authorDisplayName: null,
    url: tweet.url,
    views: nonNegative(tweet.views),
    likes: nonNegative(tweet.likes),
    retweets: nonNegative(tweet.reposts),
    replies: nonNegative(tweet.replies),
    isVerified: false,
    postedAt: Number.isFinite(tweet.createdAt) ? tweet.createdAt : null,
    collectedAt: Date.now(),
  };
}

export function normalizeTweets(tweets: XTweet[]): NormalizedTweet[] {
  return tweets.map(normalizeTweet).filter((t): t is NormalizedTweet => t !== null);
}
