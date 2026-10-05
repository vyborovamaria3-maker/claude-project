// data-tag: lib.trade.twitter_scraper
// Twitter/X scraping using hybrid architecture: Nitter (fast) + Playwright (heavy)
// Smart routing with auto-fallback between strategies

import { chromium, Page } from "playwright";
import fs from "fs";
import path from "path";

const root = process.cwd();
const defaultAuthPath = path.join(root, "data", "x-auth", "storage-state.json");
const NITTER_TIMEOUT_MS = 2500;
const PLAYWRIGHT_INITIAL_WAIT_MS = 2500;
const PLAYWRIGHT_SCROLL_WAIT_MS = 650;
const PLAYWRIGHT_MAX_EMPTY_ROUNDS = 2;
export interface TokenMeta {
  twitter?: string;
  symbol?: string;
  tokenMint?: string;
  poolAddresses?: string[];
}

const TOKEN_META_CACHE_TTL_MS = 10 * 60 * 1000;
const TOKEN_META_CACHE = new Map<
  string,
  { data: TokenMeta | null; ts: number }
>();
const SCRAPE_CACHE_TTL_MS = 2 * 60 * 1000;
const SCRAPE_CACHE = new Map<string, { data: TwitterScrapeResult; ts: number }>();
const RESERVED_X_PATHS = new Set([
  "home",
  "explore",
  "search",
  "intent",
  "share",
  "i",
  "settings",
  "messages",
  "notifications",
]);

export type CollectionStrategy = "nitter" | "playwright" | "auto";

export interface TweetData {
  id: string;
  text: string;
  authorHandle: string;
  authorDisplayName: string | null;
  url: string;
  views: number;
  likes: number;
  retweets: number;
  replies: number;
  isVerified: boolean;
  verificationKnown: boolean;
  postedAt: number | null;
}

export interface AccountData {
  handle: string;
  displayName: string | null;
  followers: number | null;
  following: number | null;
  postsCount: number | null;
  isVerified: boolean;
  verificationKnown: boolean;
  tweetsCount: number;
  totalViews: number;
  totalLikes: number;
  totalRetweets: number;
  firstTweetedAt: number | null;
  lastTweetedAt: number | null;
}

export interface TwitterScrapeResult {
  tweets: TweetData[];
  accounts: Map<string, AccountData>;
  totalViews: number;
  totalLikes: number;
  totalRetweets: number;
  uniqueAccounts: number;
  verifiedAccounts: number;
  botAccounts: number;
  botScore: number;
  botRisk: "low" | "medium" | "high";
  strategy: CollectionStrategy;
  performance: {
    responseTimeMs: number;
    cached: boolean;
  };
}

const subscriptionPatterns = [
  /paid\s+(promo|promotion|post|shill)/i,
  /dm\s+(for|me).*promo/i,
  /(vip|premium)\s+(group|calls|signals)/i,
  /subscribe|subscription|marketing package/i,
  /call channel|promo slots?|only \d+ spots/i,
];

const botPatterns = [
  /(?:buy|sell|signal|promote|crypto|gem|moon|100x)\s+(?:here|now|check|join|follow)/i,
  /only\s+\d+\s+(?:spots|slots|left)/i,
  /(?:dm|pm|telegram|discord)\s+(?:me|us|for|to)/i,
  /(?:subscribe|subscription|paid|premium|buy access)/i,
  /(?:🚀{3,}|💎{3,}|🌙{2,})/,
];

export function hasTwitterAuth(authPath: string = defaultAuthPath): boolean {
  return fs.existsSync(authPath);
}

export function normalizeTwitterHandle(
  value: string | null | undefined,
): string | undefined {
  if (!value) return undefined;
  const cleaned = String(value)
    .trim()
    .replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "")
    .replace(/^@/, "")
    .split(/[/?#]/)[0]
    .trim();
  if (!/^[A-Za-z0-9_]{1,15}$/.test(cleaned)) return undefined;
  if (RESERVED_X_PATHS.has(cleaned.toLowerCase())) return undefined;
  return cleaned;
}

function scoreTweetSuspicion(
  tweet: TweetData,
  account: AccountData,
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const views = Math.max(tweet.views || 0, 1);
  const likeRate = (tweet.likes || 0) / views;
  const rtRate = (tweet.retweets || 0) / views;

  if (tweet.views > 0 && likeRate > 0.12) {
    score += 25;
    reasons.push("very_high_like_view_ratio");
  }
  if (tweet.views > 0 && rtRate > 0.06) {
    score += 25;
    reasons.push("very_high_retweet_view_ratio");
  }
  if ((tweet.retweets || 0) > Math.max((tweet.likes || 0) * 2, 10)) {
    score += 20;
    reasons.push("retweets_much_higher_than_likes");
  }
  if (/\b(100x|gem|moon|send it|don't fade|ca:|contract)\b/i.test(tweet.text)) {
    score += 10;
    reasons.push("promo_language");
  }
  if (subscriptionPatterns.some((pattern) => pattern.test(tweet.text))) {
    score += 40;
    reasons.push("subscription_promoter_text");
  }
  if (account.verificationKnown && !account.isVerified && account.tweetsCount > 3) {
    score += 10;
    reasons.push("repeated_unverified_mentions");
  }
  if (botPatterns.some((pattern) => pattern.test(tweet.text))) {
    score += 15;
    reasons.push("bot_pattern_detected");
  }
  if (tweet.likes > tweet.retweets * 20 && tweet.retweets < 5) {
    score += 20;
    reasons.push("suspicious_engagement_ratio");
  }

  return { score: Math.min(score, 100), reasons };
}

function scoreAccountSuspicion(
  account: AccountData,
  tweets: TweetData[],
): { score: number; reasons: string[]; isSubscriptionPromoter: boolean } {
  let score = 0;
  const reasons: string[] = [];
  const allText = tweets.map((tweet) => tweet.text).join("\n");
  const isSubscriptionPromoter = subscriptionPatterns.some((pattern) =>
    pattern.test(allText),
  );
  const avgViews = account.tweetsCount ? account.totalViews / account.tweetsCount : 0;
  const avgLikes = account.tweetsCount ? account.totalLikes / account.tweetsCount : 0;
  const avgRetweets = account.tweetsCount ? account.totalRetweets / account.tweetsCount : 0;

  if (isSubscriptionPromoter) {
    score += 55;
    reasons.push("subscription_or_paid_promo_account");
  }
  if (account.verificationKnown && !account.isVerified && account.tweetsCount >= 3) {
    score += 20;
    reasons.push("many_unverified_token_mentions");
  }
  if (avgViews > 0 && avgLikes / avgViews > 0.12) {
    score += 20;
    reasons.push("account_high_like_view_ratio");
  }
  if (avgViews > 0 && avgRetweets / avgViews > 0.06) {
    score += 20;
    reasons.push("account_high_retweet_view_ratio");
  }
  if (/\b(100x|gem|alpha|calls|signals|promo|marketing|dm)\b/i.test(allText)) {
    score += 15;
    reasons.push("repeated_promo_language");
  }
  if (botPatterns.some((pattern) => pattern.test(allText))) {
    score += 15;
    reasons.push("account_bot_pattern_detected");
  }

  return { score: Math.min(score, 100), reasons, isSubscriptionPromoter };
}

function emptyAccount(handle: string): AccountData {
  return {
    handle,
    displayName: null,
    followers: null,
    following: null,
    postsCount: null,
    isVerified: false,
    verificationKnown: false,
    tweetsCount: 0,
    totalViews: 0,
    totalLikes: 0,
    totalRetweets: 0,
    firstTweetedAt: null,
    lastTweetedAt: null,
  };
}

function summarizeAccounts(tweets: TweetData[]): Map<string, AccountData> {
  const map = new Map<string, AccountData>();
  for (const tweet of tweets) {
    const handle = tweet.authorHandle || "unknown";
    const account = map.get(handle) || emptyAccount(handle);
    account.tweetsCount += 1;
    account.totalViews += tweet.views || 0;
    account.totalLikes += tweet.likes || 0;
    account.totalRetweets += tweet.retweets || 0;
    account.verificationKnown = account.verificationKnown || tweet.verificationKnown;
    account.isVerified = account.isVerified || !!tweet.isVerified;
    if (tweet.postedAt != null) {
      account.firstTweetedAt = Math.min(account.firstTweetedAt ?? Infinity, tweet.postedAt);
      account.lastTweetedAt = Math.max(account.lastTweetedAt ?? 0, tweet.postedAt);
    }
    map.set(handle, account);
  }
  return map;
}

async function collectTweets(
  page: Page,
  query: string,
  limit: number,
): Promise<TweetData[]> {
  const searchUrl = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=top`;
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(PLAYWRIGHT_INITIAL_WAIT_MS * 2);

  const currentUrl = page.url();
  console.log(`[TwitterScraper] Current URL after navigation: ${currentUrl}`);
  if (currentUrl.includes("/login") || currentUrl.includes("/i/flow/login")) {
    throw new Error(
      "X login required — auth session expired or missing. Run: node scripts/x-login.mjs",
    );
  }

  const seen = new Set<string>();
  const tweets: TweetData[] = [];
  let staleRounds = 0;

  console.log(
    `[TwitterScraper] Starting tweet collection, limit: ${limit}, query: ${query}`,
  );

  while (tweets.length < limit && staleRounds < PLAYWRIGHT_MAX_EMPTY_ROUNDS) {
    const tweetElements = await page.locator('article[data-testid="tweet"]').count();
    console.log(
      `[TwitterScraper] Found ${tweetElements} tweet elements, collected: ${tweets.length}`,
    );
    const batch = await page
      .locator('article[data-testid="tweet"]')
      .evaluateAll((articles) => {
        const parseMetric = (text: string) => {
          if (!text) return 0;
          const cleaned = text.replace(/\s+/g, "").trim();
          const match = cleaned.match(/([0-9]+(?:[.,][0-9]+)?)([KMBКМБ]?)/i);
          if (!match) return 0;
          const suffix = match[2]?.toUpperCase();
          const numeric = suffix
            ? match[1].replace(",", ".")
            : match[1].replace(/[.,]/g, "");
          const value = Number(numeric);
          if (!Number.isFinite(value)) return 0;
          if (suffix === "K" || suffix === "К") return Math.round(value * 1_000);
          if (suffix === "M" || suffix === "М") return Math.round(value * 1_000_000);
          if (suffix === "B" || suffix === "Б") {
            return Math.round(value * 1_000_000_000);
          }
          return Math.round(value);
        };

        return articles
          .map((article) => {
            const textEl = article.querySelector('[data-testid="tweetText"]');
            const text = textEl?.textContent?.trim() || "";
            const links = Array.from(article.querySelectorAll('a[href*="/status/"]'));
            const href =
              links
                .map((anchor) => anchor.getAttribute("href") || "")
                .find((candidate) => /^\/[A-Za-z0-9_]+\/status\/\d+/.test(candidate)) || "";
            const id = href.match(/\/status\/(\d+)/)?.[1] || "";
            const authorHandle = href.split("/").filter(Boolean)[0] || "";
            const url = href ? `https://x.com${href.split("/analytics")[0]}` : "";
            const time = article.querySelector("time")?.getAttribute("datetime") || null;
            const isVerified = !!article.querySelector(
              '[data-testid="icon-verified"], svg[aria-label="Verified account"]',
            );
            const reply = parseMetric(
              article.querySelector('[data-testid="reply"]')?.textContent || "",
            );
            const retweet = parseMetric(
              article.querySelector('[data-testid="retweet"]')?.textContent || "",
            );
            const like = parseMetric(
              article.querySelector('[data-testid="like"]')?.textContent || "",
            );
            const analyticsLink = article.querySelector('a[href$="/analytics"]');
            const analyticsAria = analyticsLink?.getAttribute("aria-label") || "";
            const aria = article.textContent || "";
            const viewsCandidate =
              analyticsAria.match(/([0-9.,]+[KMBКМБ]?)\s*(?:Views|просмотр)/i)?.[1] ||
              aria.match(/([0-9.,]+[KMBКМБ]?)\s*(?:Views|просмотр|просмотров)/i)?.[1] ||
              "";
            const views = parseMetric(viewsCandidate);
            const displayNameEl = article.querySelector('[data-testid="User-Name"] span');
            const displayName = displayNameEl?.textContent?.trim() || null;
            const postedAt = time ? Date.parse(time) : null;

            return {
              id,
              text,
              authorHandle,
              authorDisplayName: displayName,
              url,
              views,
              likes: like,
              retweets: retweet,
              replies: reply,
              isVerified,
              verificationKnown: true,
              postedAt: postedAt != null && Number.isFinite(postedAt) ? postedAt : null,
            };
          })
          .filter((tweet) => tweet.id && tweet.authorHandle && tweet.text);
      });

    const before = tweets.length;
    for (const tweet of batch) {
      if (seen.has(tweet.id)) continue;
      seen.add(tweet.id);
      tweets.push(tweet);
      if (tweets.length >= limit) break;
    }

    staleRounds = tweets.length === before ? staleRounds + 1 : 0;
    await page.mouse.wheel(0, 1800);
    await page.waitForTimeout(PLAYWRIGHT_SCROLL_WAIT_MS);
  }

  return tweets;
}

async function collectTweetsViaPlaywright(
  query: string,
  limit: number,
  authPath: string,
  headless: boolean,
): Promise<TweetData[]> {
  const useAuth = hasTwitterAuth(authPath);
  const browser = await chromium.launch({ headless, slowMo: headless ? 0 : 80 });
  const context = await browser.newContext({
    storageState: useAuth ? authPath : undefined,
    viewport: { width: 1365, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });
  await context.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (type === "image" || type === "media" || type === "font") return route.abort();
    return route.continue();
  });
  const page = await context.newPage();

  try {
    return await collectTweets(page, query, limit);
  } finally {
    await browser.close();
  }
}

function decodeNitterText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function collectTweetsViaNitter(query: string, limit: number): Promise<TweetData[]> {
  const instances = [
    "https://nitter.net",
    "https://nitter.poast.org",
    "https://nitter.1d4.us",
    "https://nitter.privacydev.net",
  ];

  const attempts = instances.map(async (instance) => {
    try {
      const url = `${instance}/search?q=${encodeURIComponent(query)}&f=tweets`;
      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "text/html",
        },
        signal: AbortSignal.timeout(NITTER_TIMEOUT_MS),
      });
      if (!response.ok) return [];
      const html = await response.text();
      return parseNitterHTML(html, limit);
    } catch {
      return [];
    }
  });

  const results = await Promise.allSettled(attempts);
  return (
    results
      .map((result) => (result.status === "fulfilled" ? result.value : []))
      .find((tweets) => tweets.length > 0) || []
  );
}

function parseNitterHTML(html: string, limit: number): TweetData[] {
  const tweets: TweetData[] = [];
  const cardRegex = /<div class="timeline-item[^"]*">([\s\S]*?)(?=<div class="timeline-item|$)/g;
  let cardMatch: RegExpExecArray | null;

  while ((cardMatch = cardRegex.exec(html)) !== null && tweets.length < limit) {
    const card = cardMatch[1];
    const textMatch = card.match(/<div class="tweet-content[^"]*">([\s\S]*?)<\/div>/);
    const text = textMatch ? decodeNitterText(textMatch[1]) : "";
    if (!text) continue;

    const handleMatch = card.match(/class="username"[^>]*>@?([A-Za-z0-9_]+)/);
    const author = normalizeTwitterHandle(handleMatch?.[1]);
    const idMatch = card.match(/\/status\/(\d+)/);
    const id = idMatch?.[1] || "";
    if (!author || !id) continue;

    const likesMatch =
      card.match(/(\d+)<\/span>\s*<span[^>]*>(?:Like|Нравится)/i) ||
      card.match(/icon-heart[^>]*>[\s\S]*?(\d+)/);
    const rtMatch =
      card.match(/(\d+)<\/span>\s*<span[^>]*>(?:Retweet|Ретвит)/i) ||
      card.match(/icon-retweet[^>]*>[\s\S]*?(\d+)/);
    const dateMatch = card.match(/class="tweet-date"[^>]*>[\s\S]*?title="([^"]+)"/i);
    const parsedDate = dateMatch ? Date.parse(dateMatch[1].replace(" · ", " ")) : NaN;

    tweets.push({
      id,
      text: text.slice(0, 4000),
      authorHandle: author,
      authorDisplayName: null,
      url: `https://x.com/${author}/status/${id}`,
      views: 0,
      likes: likesMatch ? Number.parseInt(likesMatch[1], 10) || 0 : 0,
      retweets: rtMatch ? Number.parseInt(rtMatch[1], 10) || 0 : 0,
      replies: 0,
      isVerified: false,
      verificationKnown: false,
      postedAt: Number.isFinite(parsedDate) ? parsedDate : null,
    });
  }

  return tweets;
}

export async function scrapeTwitter(
  query: string,
  options: {
    limit?: number;
    authPath?: string;
    headless?: boolean;
    strategy?: CollectionStrategy;
  } = {},
): Promise<TwitterScrapeResult> {
  const {
    limit = 20,
    authPath = defaultAuthPath,
    headless = true,
    strategy = "auto",
  } = options;
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const startTime = Date.now();
  const cacheKey = `${strategy}:${boundedLimit}:${query}`;
  const cached = SCRAPE_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < SCRAPE_CACHE_TTL_MS) {
    return {
      ...cached.data,
      performance: {
        ...cached.data.performance,
        responseTimeMs: 0,
        cached: true,
      },
    };
  }

  let tweets: TweetData[] = [];
  let usedStrategy: CollectionStrategy = strategy;

  if (strategy === "auto") {
    tweets = await collectTweetsViaNitter(query, boundedLimit);
    if (tweets.length > 0) {
      usedStrategy = "nitter";
    } else if (!hasTwitterAuth(authPath)) {
      usedStrategy = "nitter";
    } else {
      tweets = await collectTweetsViaPlaywright(
        query,
        boundedLimit,
        authPath,
        headless,
      );
      usedStrategy = "playwright";
    }
  } else if (strategy === "nitter") {
    tweets = await collectTweetsViaNitter(query, boundedLimit);
    usedStrategy = "nitter";
  } else {
    tweets = await collectTweetsViaPlaywright(query, boundedLimit, authPath, headless);
    usedStrategy = "playwright";
  }

  const responseTimeMs = Date.now() - startTime;
  const accounts = summarizeAccounts(tweets);

  const analyzedTweets = tweets.map((tweet) => {
    const account = accounts.get(tweet.authorHandle) || emptyAccount(tweet.authorHandle);
    const suspicion = scoreTweetSuspicion(tweet, account);
    return {
      ...tweet,
      isSuspicious: suspicion.score >= 50,
      suspicionScore: suspicion.score,
      suspicionReasons: suspicion.reasons,
    };
  });

  const analyzedAccounts = Array.from(accounts.values()).map((account) => {
    const accountTweets = analyzedTweets.filter(
      (tweet) => tweet.authorHandle === account.handle,
    );
    const suspicion = scoreAccountSuspicion(account, accountTweets);
    return {
      ...account,
      botScore: suspicion.score,
      isBot: suspicion.score >= 60,
      isSubscriptionPromoter: suspicion.isSubscriptionPromoter,
      botReasons: suspicion.reasons,
    };
  });

  analyzedAccounts.forEach((account) => {
    accounts.set(account.handle, account);
  });

  const totalViews = analyzedTweets.reduce((sum, tweet) => sum + tweet.views, 0);
  const totalLikes = analyzedTweets.reduce((sum, tweet) => sum + tweet.likes, 0);
  const totalRetweets = analyzedTweets.reduce((sum, tweet) => sum + tweet.retweets, 0);
  const uniqueAccounts = accounts.size;
  const verifiedAccounts = analyzedAccounts.filter(
    (account) => account.verificationKnown && account.isVerified,
  ).length;
  const botAccounts = analyzedAccounts.filter((account) => account.isBot).length;

  const suspiciousRatio = analyzedTweets.length
    ? analyzedTweets.filter((tweet) => tweet.isSuspicious).length / analyzedTweets.length
    : 0;
  const botRatio = uniqueAccounts ? botAccounts / uniqueAccounts : 0;
  const botScore = Math.round(suspiciousRatio * 50 + botRatio * 50);
  const botRisk: "low" | "medium" | "high" =
    botScore >= 65 ? "high" : botScore >= 35 ? "medium" : "low";

  const result: TwitterScrapeResult = {
    tweets: analyzedTweets,
    accounts,
    totalViews,
    totalLikes,
    totalRetweets,
    uniqueAccounts,
    verifiedAccounts,
    botAccounts,
    botScore,
    botRisk,
    strategy: usedStrategy,
    performance: {
      responseTimeMs,
      cached: false,
    },
  };
  SCRAPE_CACHE.set(cacheKey, { data: result, ts: Date.now() });
  return result;
}

// ── User timeline (author profile) collection ─────────────────

/**
 * How much of the author's history the timeline covered:
 * - "complete": scrolled to the end of the visible timeline before the limit;
 * - "partial":  stopped at the requested limit (more history may exist);
 * - "nitter":   served by the Nitter fallback (basic fields only).
 */
export type UserTimelineHistoryMode = "complete" | "partial" | "nitter";

export interface UserTimelineTweet {
  id: string;
  text: string;
  url: string;
  /** Unix milliseconds. */
  postedAt: number | null;
  views: number;
  viewsKnown: boolean;
  likes: number;
  retweets: number;
  replies: number;
  quotes: number;
  bookmarks: number;
  authorHandle: string;
  authorDisplayName: string | null;
  isVerified: boolean;
  authorFollowers: number | null;
  authorFollowing: number | null;
  authorPostsCount: number | null;
  authorListedCount: number | null;
  authorFavouritesCount: number | null;
  authorMediaCount: number | null;
  /** Account creation date, unix milliseconds. */
  authorCreatedAt: number | null;
  authorLocation: string | null;
  authorIsBlueVerified: boolean;
  authorVerificationType: string | null;
}

export interface UserTimelineResult {
  tweets: UserTimelineTweet[];
  historyMode: UserTimelineHistoryMode;
}

export interface UserProfileHeader {
  followers: number | null;
  following: number | null;
  posts: number | null;
  listed: number | null;
  favourites: number | null;
  media: number | null;
  createdAt: number | null;
  location: string | null;
  isBlueVerified: boolean;
  verificationType: string | null;
}

const TIMELINE_CACHE_TTL_MS = 5 * 60 * 1000;
const TIMELINE_CACHE = new Map<string, { data: UserTimelineResult; ts: number }>();

async function collectUserTimelineViaPlaywright(
  handle: string,
  limit: number,
  authPath: string,
  headless: boolean,
): Promise<UserTimelineResult> {
  const useAuth = hasTwitterAuth(authPath);
  const browser = await chromium.launch({ headless, slowMo: headless ? 0 : 80 });
  const context = await browser.newContext({
    storageState: useAuth ? authPath : undefined,
    viewport: { width: 1365, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });
  await context.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (type === "image" || type === "media" || type === "font") return route.abort();
    return route.continue();
  });
  const page = await context.newPage();

  try {
    await page.goto(`https://x.com/${handle}`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(PLAYWRIGHT_INITIAL_WAIT_MS);

    const currentUrl = page.url();
    if (currentUrl.includes("/login") || currentUrl.includes("/i/flow/login")) {
      throw new Error(
        "X login required — auth session expired or missing. Run: node scripts/x-login.mjs",
      );
    }

    const header = await page.evaluate((profileHandle) => {
      const parseCount = (raw: string | null | undefined): number | null => {
        if (!raw) return null;
        const cleaned = String(raw).replace(/\s+/g, "").toUpperCase();
        if (!cleaned) return null;
        const match = cleaned.match(/^([0-9]+(?:[.,][0-9]+)?)([KMBКМБ])?$/);
        if (!match) {
          const digits = cleaned.replace(/[^\d]/g, "");
          const plain = digits ? Number.parseInt(digits, 10) : Number.NaN;
          return Number.isFinite(plain) && plain >= 0 ? plain : null;
        }
        const value = Number.parseFloat(match[1].replace(",", "."));
        if (!Number.isFinite(value)) return null;
        const factor =
          match[2] === "K" || match[2] === "К" ? 1_000 :
          match[2] === "M" || match[2] === "М" ? 1_000_000 :
          match[2] === "B" || match[2] === "Б" ? 1_000_000_000 :
          1;
        return Math.round(value * factor);
      };
      const lowerHandle = profileHandle.toLowerCase();
      const anchors = Array.from(document.querySelectorAll("a"));
      const anchorFor = (suffix: string) =>
        anchors.find((anchor) => {
          const href = (anchor.getAttribute("href") || "").toLowerCase();
          return suffix
            ? href === `/${lowerHandle}/${suffix}`
            : href === `/${lowerHandle}`;
        });
      const countOf = (anchor: Element | undefined): number | null => {
        if (!anchor) return null;
        const titled = anchor.querySelector("span[title]");
        return parseCount(titled?.getAttribute("title") || anchor.textContent || "");
      };

      const bodyText = document.body?.innerText || "";
      const joinedMatch = bodyText.match(
        /Joined\s+([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/,
      );
      let createdAt: number | null = null;
      if (joinedMatch) {
        const parsed = Date.parse(joinedMatch[1]);
        if (Number.isFinite(parsed)) createdAt = parsed;
      }

      const locationEl = document.querySelector('[data-testid="UserProfileHeader_Items"] span');
      const isBlueVerified = !!document.querySelector(
        '[data-testid="UserName"] svg[aria-label*="Verified" i], [data-testid="UserName"] a[href="/verified"]',
      );

      return {
        followers: countOf(anchorFor("followers")),
        following: countOf(anchorFor("following")),
        posts: countOf(anchorFor("with_replies")) ?? countOf(anchorFor("")),
        listed: null,
        favourites: null,
        media: countOf(anchorFor("media")),
        createdAt,
        location: locationEl?.textContent?.trim() || null,
        isBlueVerified,
        verificationType: isBlueVerified ? "blue" : null,
      };
    }, handle);

    const seen = new Set<string>();
    const tweets: UserTimelineTweet[] = [];
    let staleRounds = 0;

    while (tweets.length < limit && staleRounds < PLAYWRIGHT_MAX_EMPTY_ROUNDS) {
      const batch = await page
        .locator('article[data-testid="tweet"]')
        .evaluateAll((articles) => {
          const parseMetric = (text: string) => {
            if (!text) return 0;
            const cleaned = text.replace(/\s+/g, "").trim();
            const match = cleaned.match(/([0-9]+(?:[.,][0-9]+)?)([KMBКМБ]?)/i);
            if (!match) return 0;
            const suffix = match[2]?.toUpperCase();
            const numeric = suffix
              ? match[1].replace(",", ".")
              : match[1].replace(/[.,]/g, "");
            const value = Number(numeric);
            if (!Number.isFinite(value)) return 0;
            if (suffix === "K" || suffix === "К") return Math.round(value * 1_000);
            if (suffix === "M" || suffix === "М") return Math.round(value * 1_000_000);
            if (suffix === "B" || suffix === "Б") {
              return Math.round(value * 1_000_000_000);
            }
            return Math.round(value);
          };

          return articles
            .map((article) => {
              const textEl = article.querySelector('[data-testid="tweetText"]');
              const text = textEl?.textContent?.trim() || "";
              const links = Array.from(article.querySelectorAll('a[href*="/status/"]'));
              const href =
                links
                  .map((anchor) => anchor.getAttribute("href") || "")
                  .find((candidate) => /^\/[A-Za-z0-9_]+\/status\/\d+/.test(candidate)) || "";
              const id = href.match(/\/status\/(\d+)/)?.[1] || "";
              const authorHandle = href.split("/").filter(Boolean)[0] || "";
              const url = href ? `https://x.com${href.split("/analytics")[0]}` : "";
              const time = article.querySelector("time")?.getAttribute("datetime") || null;
              const isVerified = !!article.querySelector(
                '[data-testid="icon-verified"], svg[aria-label="Verified account"]',
              );
              const reply = parseMetric(
                article.querySelector('[data-testid="reply"]')?.textContent || "",
              );
              const retweet = parseMetric(
                article.querySelector('[data-testid="retweet"]')?.textContent || "",
              );
              const like = parseMetric(
                article.querySelector('[data-testid="like"]')?.textContent || "",
              );
              const analyticsLink = article.querySelector('a[href$="/analytics"]');
              const analyticsAria = analyticsLink?.getAttribute("aria-label") || "";
              const aria = article.textContent || "";
              const viewsCandidate =
                analyticsAria.match(/([0-9.,]+[KMBКМБ]?)\s*(?:Views|просмотр)/i)?.[1] ||
                aria.match(/([0-9.,]+[KMBКМБ]?)\s*(?:Views|просмотр|просмотров)/i)?.[1] ||
                "";
              const views = parseMetric(viewsCandidate);
              const displayNameEl = article.querySelector('[data-testid="User-Name"] span');
              const displayName = displayNameEl?.textContent?.trim() || null;
              const postedAt = time ? Date.parse(time) : null;

              return {
                id,
                text,
                authorHandle,
                authorDisplayName: displayName,
                url,
                views,
                likes: like,
                retweets: retweet,
                replies: reply,
                isVerified,
                postedAt: postedAt != null && Number.isFinite(postedAt) ? postedAt : null,
              };
            })
            .filter((tweet) => tweet.id && tweet.authorHandle && tweet.text);
        });

      const before = tweets.length;
      for (const tweet of batch) {
        if (seen.has(tweet.id)) continue;
        seen.add(tweet.id);
        tweets.push({
          id: tweet.id,
          text: tweet.text,
          url: tweet.url,
          postedAt: tweet.postedAt,
          views: tweet.views,
          viewsKnown: tweet.views > 0,
          likes: tweet.likes,
          retweets: tweet.retweets,
          replies: tweet.replies,
          quotes: 0,
          bookmarks: 0,
          authorHandle: tweet.authorHandle || handle,
          authorDisplayName: tweet.authorDisplayName,
          isVerified: tweet.isVerified,
          authorFollowers: header.followers,
          authorFollowing: header.following,
          authorPostsCount: header.posts,
          authorListedCount: header.listed,
          authorFavouritesCount: header.favourites,
          authorMediaCount: header.media,
          authorCreatedAt: header.createdAt,
          authorLocation: header.location,
          authorIsBlueVerified: header.isBlueVerified,
          authorVerificationType: header.verificationType,
        });
        if (tweets.length >= limit) break;
      }

      staleRounds = tweets.length === before ? staleRounds + 1 : 0;
      await page.mouse.wheel(0, 1800);
      await page.waitForTimeout(PLAYWRIGHT_SCROLL_WAIT_MS);
    }

    return {
      tweets,
      historyMode: tweets.length >= limit ? "partial" : "complete",
    };
  } finally {
    await browser.close();
  }
}

async function collectUserTimelineViaNitter(
  handle: string,
  limit: number,
): Promise<UserTimelineTweet[]> {
  const instances = [
    "https://nitter.net",
    "https://nitter.poast.org",
    "https://nitter.1d4.us",
    "https://nitter.privacydev.net",
  ];

  const attempts = instances.map(async (instance) => {
    try {
      const response = await fetch(`${instance}/${handle}`, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "text/html",
        },
        signal: AbortSignal.timeout(NITTER_TIMEOUT_MS),
      });
      if (!response.ok) return [];
      const html = await response.text();
      return parseNitterHTML(html, limit);
    } catch {
      return [];
    }
  });

  const results = await Promise.allSettled(attempts);
  const found =
    results
      .map((result) => (result.status === "fulfilled" ? result.value : []))
      .find((tweets) => tweets.length > 0) || [];

  return found.map((tweet) => ({
    id: tweet.id,
    text: tweet.text,
    url: tweet.url,
    postedAt: tweet.postedAt,
    views: 0,
    viewsKnown: false,
    likes: tweet.likes,
    retweets: tweet.retweets,
    replies: tweet.replies,
    quotes: 0,
    bookmarks: 0,
    authorHandle: tweet.authorHandle || handle,
    authorDisplayName: tweet.authorDisplayName,
    isVerified: tweet.isVerified,
    authorFollowers: null,
    authorFollowing: null,
    authorPostsCount: null,
    authorListedCount: null,
    authorFavouritesCount: null,
    authorMediaCount: null,
    authorCreatedAt: null,
    authorLocation: null,
    authorIsBlueVerified: false,
    authorVerificationType: null,
  }));
}

/**
 * Fetch an author's own timeline (profile posts) with best-effort profile
 * stats. Playwright is primary (rich fields); Nitter is the fallback.
 * Throws when no posts can be retrieved from either source.
 */
export async function scrapeTwitterUserTimeline(
  handle: string,
  options: {
    limit?: number;
    authPath?: string;
    headless?: boolean;
  } = {},
): Promise<UserTimelineResult> {
  const clean = normalizeTwitterHandle(handle);
  if (!clean) throw new Error("invalid X handle");
  const limit = Math.max(1, Math.min(60, Math.trunc(options.limit ?? 20)));
  const cacheKey = `timeline:${clean.toLowerCase()}:${limit}`;
  const cached = TIMELINE_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < TIMELINE_CACHE_TTL_MS) {
    return { ...cached.data, tweets: [...cached.data.tweets] };
  }

  let result: UserTimelineResult | null = null;
  try {
    result = await collectUserTimelineViaPlaywright(
      clean,
      limit,
      options.authPath ?? defaultAuthPath,
      options.headless ?? true,
    );
  } catch (error) {
    console.warn(
      `[TwitterScraper] profile timeline via Playwright failed for @${clean}:`,
      error instanceof Error ? error.message : error,
    );
  }
  if (!result || result.tweets.length === 0) {
    const tweets = await collectUserTimelineViaNitter(clean, limit);
    if (tweets.length > 0) result = { tweets, historyMode: "nitter" };
  }
  if (!result || result.tweets.length === 0) {
    throw new Error(
      "X author timeline unavailable (Playwright and Nitter both returned no posts)",
    );
  }

  TIMELINE_CACHE.set(cacheKey, { data: result, ts: Date.now() });
  return result;
}

/** Pool/pair addresses for a mint (best-effort, used for contract-address mention matching). */
async function fetchPoolAddresses(mint: string): Promise<string[]> {
  try {
    const response = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(3500),
      },
    );
    if (!response.ok) return [];
    const payload = (await response.json()) as {
      pairs?: Array<{ chainId?: string; pairAddress?: string }>;
    };
    const pairs = Array.isArray(payload?.pairs) ? payload.pairs : [];
    const addresses = pairs
      .filter((pair) => !pair?.chainId || pair.chainId === "solana")
      .map((pair) => pair?.pairAddress)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    return [...new Set(addresses)].slice(0, 6);
  } catch {
    return [];
  }
}

export async function fetchTokenMeta(mint: string): Promise<TokenMeta | null> {
  const cached = TOKEN_META_CACHE.get(mint);
  if (cached && Date.now() - cached.ts < TOKEN_META_CACHE_TTL_MS) return cached.data;

  const endpoints = [
    `https://frontend-api-v3.pump.fun/coins/${encodeURIComponent(mint)}`,
    `https://frontend-api.pump.fun/coins/${encodeURIComponent(mint)}`,
  ];

  const attempts = endpoints.map(async (url) => {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
        signal: AbortSignal.timeout(3500),
      });
      if (!response.ok) return null;
      const data = await response.json();
      return {
        twitter: normalizeTwitterHandle(data.twitter),
        symbol: typeof data.symbol === "string" ? data.symbol : undefined,
        tokenMint: typeof data.mint === "string" ? data.mint : undefined,
      };
    } catch {
      return null;
    }
  });

  const results = await Promise.allSettled(attempts);
  const data =
    results
      .map((result) => (result.status === "fulfilled" ? result.value : null))
      .find(Boolean) || null;
  const enriched: TokenMeta | null = data
    ? { ...data, poolAddresses: await fetchPoolAddresses(mint) }
    : null;
  TOKEN_META_CACHE.set(mint, { data: enriched, ts: Date.now() });
  return enriched;
}

export function buildQuery({
  mint,
  symbol,
  tokenTwitterHandle,
  scope = "mentions",
}: {
  mint?: string;
  symbol?: string;
  tokenTwitterHandle?: string;
  scope?: "mentions" | "official";
}): string {
  const cleanHandle = normalizeTwitterHandle(tokenTwitterHandle);
  if (scope === "official") {
    return cleanHandle ? `from:${cleanHandle}` : "";
  }

  const parts = new Set<string>();
  const cleanSymbol = symbol?.trim().replace(/^\$/, "");
  const cleanMint = mint?.trim();
  if (cleanSymbol && /^[A-Za-z0-9_]{1,32}$/.test(cleanSymbol)) {
    parts.add(`$${cleanSymbol}`);
    if (cleanSymbol.length > 2) parts.add(cleanSymbol);
  }
  if (cleanMint) parts.add(cleanMint);
  if (cleanHandle) parts.add(`@${cleanHandle}`);
  return Array.from(parts).slice(0, 4).join(" OR ");
}
