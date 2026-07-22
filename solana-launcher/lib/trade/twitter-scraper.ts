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
const TOKEN_META_CACHE_TTL_MS = 10 * 60 * 1000;
const TOKEN_META_CACHE = new Map<string, { data: { twitter?: string; symbol?: string } | null; ts: number }>();
const SCRAPE_CACHE_TTL_MS = 2 * 60 * 1000;
const SCRAPE_CACHE = new Map<string, { data: TwitterScrapeResult; ts: number }>();

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
  postedAt: number | null;
}

export interface AccountData {
  handle: string;
  displayName: string | null;
  followers: number | null;
  following: number | null;
  postsCount: number | null;
  isVerified: boolean;
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

// Enhanced bot patterns from spec
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

export function normalizeTwitterHandle(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = String(value)
    .trim()
    .replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "")
    .replace(/^@/, "")
    .split(/[/?#]/)[0]
    .trim();
  return cleaned || undefined;
}

function scoreTweetSuspicion(tweet: TweetData, account: AccountData): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const views = Math.max(tweet.views || 0, 1);
  const likeRate = (tweet.likes || 0) / views;
  const rtRate = (tweet.retweets || 0) / views;

  if (tweet.views > 0 && likeRate > 0.12) { score += 25; reasons.push("very_high_like_view_ratio"); }
  if (tweet.views > 0 && rtRate > 0.06) { score += 25; reasons.push("very_high_retweet_view_ratio"); }
  if ((tweet.retweets || 0) > Math.max((tweet.likes || 0) * 2, 10)) { score += 20; reasons.push("retweets_much_higher_than_likes"); }
  if (/\b(100x|gem|moon|send it|don't fade|ca:|contract)\b/i.test(tweet.text)) { score += 10; reasons.push("promo_language"); }
  if (subscriptionPatterns.some((p) => p.test(tweet.text))) { score += 40; reasons.push("subscription_promoter_text"); }
  if (!account.isVerified && account.tweetsCount > 3) { score += 10; reasons.push("repeated_unverified_mentions"); }
  
  // Enhanced bot detection from spec
  if (botPatterns.some((p) => p.test(tweet.text))) { score += 15; reasons.push("bot_pattern_detected"); }
  if (tweet.likes > tweet.retweets * 20 && tweet.retweets < 5) { score += 20; reasons.push("suspicious_engagement_ratio"); }

  return { score: Math.min(score, 100), reasons };
}

function scoreAccountSuspicion(account: AccountData, tweets: TweetData[]): { score: number; reasons: string[]; isSubscriptionPromoter: boolean } {
  let score = 0;
  const reasons: string[] = [];
  const allText = tweets.map((tweet) => tweet.text).join("\n");
  const isSubscriptionPromoter = subscriptionPatterns.some((p) => p.test(allText));
  const avgViews = account.tweetsCount ? account.totalViews / account.tweetsCount : 0;
  const avgLikes = account.tweetsCount ? account.totalLikes / account.tweetsCount : 0;
  const avgRetweets = account.tweetsCount ? account.totalRetweets / account.tweetsCount : 0;

  if (isSubscriptionPromoter) { score += 55; reasons.push("subscription_or_paid_promo_account"); }
  if (!account.isVerified && account.tweetsCount >= 3) { score += 20; reasons.push("many_unverified_token_mentions"); }
  if (avgViews > 0 && avgLikes / avgViews > 0.12) { score += 20; reasons.push("account_high_like_view_ratio"); }
  if (avgViews > 0 && avgRetweets / avgViews > 0.06) { score += 20; reasons.push("account_high_retweet_view_ratio"); }
  if (/\b(100x|gem|alpha|calls|signals|promo|marketing|dm)\b/i.test(allText)) { score += 15; reasons.push("repeated_promo_language"); }
  if (botPatterns.some((p) => p.test(allText))) { score += 15; reasons.push("account_bot_pattern_detected"); }

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
    account.isVerified = account.isVerified || !!tweet.isVerified;
    if (tweet.postedAt != null) {
      account.firstTweetedAt = Math.min(account.firstTweetedAt ?? Infinity, tweet.postedAt);
      account.lastTweetedAt = Math.max(account.lastTweetedAt ?? 0, tweet.postedAt);
    }
    map.set(handle, account);
  }
  return map;
}

async function collectTweets(page: Page, query: string, limit: number): Promise<TweetData[]> {
  const searchUrl = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=top`;
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(PLAYWRIGHT_INITIAL_WAIT_MS * 2);

  // Detect login redirect — auth session expired/missing
  const currentUrl = page.url();
  console.log(`[TwitterScraper] Current URL after navigation: ${currentUrl}`);
  if (currentUrl.includes("/login") || currentUrl.includes("/i/flow/login")) {
    throw new Error("X login required — auth session expired or missing. Run: node scripts/x-login.mjs");
  }

  const seen = new Set();
  const tweets: TweetData[] = [];
  let staleRounds = 0;

  console.log(`[TwitterScraper] Starting tweet collection, limit: ${limit}, query: ${query}`);

  while (tweets.length < limit && staleRounds < PLAYWRIGHT_MAX_EMPTY_ROUNDS) {
    const tweetElements = await page.locator('article[data-testid="tweet"]').count();
    console.log(`[TwitterScraper] Found ${tweetElements} tweet elements on page, collected so far: ${tweets.length}`);
    const batch = await page.locator('article[data-testid="tweet"]').evaluateAll((articles) => {
      const parseMetric = (text: string) => {
        if (!text) return 0;
        const cleaned = text.replace(/,/g, ".").trim();
        const match = cleaned.match(/([0-9]+(?:\.[0-9]+)?)([KMBКМБ]?)/i);
        if (!match) return 0;
        const value = Number(match[1]);
        const suffix = match[2]?.toUpperCase();
        if (suffix === "K" || suffix === "К") return Math.round(value * 1_000);
        if (suffix === "M" || suffix === "М") return Math.round(value * 1_000_000);
        if (suffix === "B" || suffix === "Б") return Math.round(value * 1_000_000_000);
        return Math.round(value);
      };

      return articles.map((article) => {
        const textEl = article.querySelector('[data-testid="tweetText"]');
        const text = textEl?.textContent?.trim() || "";
        const links = Array.from(article.querySelectorAll('a[href*="/status/"]'));
        const href = links.map((a) => a.getAttribute("href") || "").find((h) => /\/status\/\d+/.test(h)) || "";
        const id = href.match(/\/status\/(\d+)/)?.[1] || "";
        const authorHandle = href.split("/").filter(Boolean)[0] || "unknown";
        const url = href ? `https://x.com${href.split("/analytics")[0]}` : "";
        const time = article.querySelector("time")?.getAttribute("datetime") || null;
        const isVerified = !!article.querySelector('[data-testid="icon-verified"], svg[aria-label="Verified account"]');
        const reply = parseMetric(article.querySelector('[data-testid="reply"]')?.textContent || "");
        const retweet = parseMetric(article.querySelector('[data-testid="retweet"]')?.textContent || "");
        const like = parseMetric(article.querySelector('[data-testid="like"]')?.textContent || "");
        // Views: prefer aria-label of analytics link, then text container, then full text
        const analyticsLink = article.querySelector('a[href$="/analytics"]');
        const analyticsAria = analyticsLink?.getAttribute("aria-label") || "";
        const aria = article.textContent || "";
        const viewsCandidate =
          analyticsAria.match(/([0-9.,]+[KMBКМБ]?)\s*(?:Views|просмотр)/i)?.[1] ||
          aria.match(/([0-9.,]+[KMBКМБ]?)\s*(?:Views|просмотр|просмотров)/i)?.[1] ||
          "";
        const views = parseMetric(viewsCandidate);
        
        // Try to get author display name
        const displayNameEl = article.querySelector('[data-testid="User-Name"] span');
        const displayName = displayNameEl?.textContent?.trim() || null;

        return { id, text, authorHandle, authorDisplayName: displayName, url, views, likes: like, retweets: retweet, replies: reply, isVerified, postedAt: time ? Date.parse(time) : null };
      }).filter((tweet) => tweet.id && tweet.text);
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

// Playwright collection - heavy layer with full metrics
async function collectTweetsViaPlaywright(query: string, limit: number, authPath: string, headless: boolean): Promise<TweetData[]> {
  const useAuth = hasTwitterAuth(authPath);

  const browser = await chromium.launch({ headless, slowMo: headless ? 0 : 80 });
  const context = await browser.newContext({
    storageState: useAuth ? authPath : undefined,
    viewport: { width: 1365, height: 900 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });
  await context.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (type === "image" || type === "media" || type === "font") return route.abort();
    return route.continue();
  });
  const page = await context.newPage();

  let tweets: TweetData[] = [];
  try {
    tweets = await collectTweets(page, query, limit);
  } finally {
    await browser.close();
  }

  return tweets;
}

// Nitter fallback - fast layer without views
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
      const r = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "text/html",
        },
        signal: AbortSignal.timeout(NITTER_TIMEOUT_MS),
      });
      if (!r.ok) return [];

      const html = await r.text();
      return parseNitterHTML(html, limit);
    } catch {
      return [];
    }
  });

  const results = await Promise.allSettled(attempts);
  return results
    .map((result) => result.status === "fulfilled" ? result.value : [])
    .find((tweets) => tweets.length > 0) || [];
}

function parseNitterHTML(html: string, limit: number): TweetData[] {
  const tweets: TweetData[] = [];
  const cardRegex = /<div class="timeline-item[^"]*">([\s\S]*?)(?=<div class="timeline-item|$)/g;
  let cardMatch;
  let idx = 0;

  while ((cardMatch = cardRegex.exec(html)) !== null && idx < limit) {
    const card = cardMatch[1];

    const textMatch = card.match(/<div class="tweet-content[^"]*">([\s\S]*?)<\/div>/);
    const text = textMatch ? textMatch[1].replace(/<[^>]+>/g, "").trim() : "";
    if (!text) continue;

    const handleMatch = card.match(/class="username"[^>]*>@?([A-Za-z0-9_]+)/);
    const author = handleMatch ? handleMatch[1] : "unknown";

    const idMatch = card.match(/\/status\/(\d+)/);
    const id = idMatch ? idMatch[1] : `nitter-${idx}`;

    const likesMatch = card.match(/(\d+)<\/span>\s*<span[^>]*>(?:Like|Нравится)/i) ||
                       card.match(/icon-heart[^>]*>[\s\S]*?(\d+)/);
    const rtMatch = card.match(/(\d+)<\/span>\s*<span[^>]*>(?:Retweet|Ретвит)/i) ||
                    card.match(/icon-retweet[^>]*>[\s\S]*?(\d+)/);

    // Real timestamp from <a class="tweet-date"><a title="Aug 28, 2024 · 12:34 UTC">
    const dateMatch = card.match(/class="tweet-date"[^>]*>[\s\S]*?title="([^"]+)"/i);
    const postedAt = dateMatch ? (Date.parse(dateMatch[1].replace(" · ", " ").replace(" UTC", " UTC")) || null) : null;

    tweets.push({
      id,
      text: text.slice(0, 280),
      authorHandle: author,
      authorDisplayName: null,
      url: `https://x.com/i/status/${id}`,
      views: 0, // Nitter doesn't expose views
      likes: likesMatch ? parseInt(likesMatch[1]) : 0,
      retweets: rtMatch ? parseInt(rtMatch[1]) : 0,
      replies: 0,
      isVerified: false,
      postedAt,
    });
    idx++;
  }

  return tweets;
}

export async function scrapeTwitter(query: string, options: {
  limit?: number;
  authPath?: string;
  headless?: boolean;
  strategy?: CollectionStrategy;
} = {}): Promise<TwitterScrapeResult> {
  const {
    limit = 20,
    authPath = defaultAuthPath,
    headless = true,
    strategy = "auto",
  } = options;

  const startTime = Date.now();
  const cacheKey = `${strategy}:${limit}:${query}`;
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

  // Smart routing: try Nitter first for speed, fallback to Playwright
  if (strategy === "auto") {
    tweets = await collectTweetsViaNitter(query, limit);
    if (tweets.length > 0) {
      usedStrategy = "nitter";
    } else if (!hasTwitterAuth(authPath)) {
      usedStrategy = "nitter";
    } else {
      tweets = await collectTweetsViaPlaywright(query, limit, authPath, headless);
      usedStrategy = "playwright";
    }
  } else if (strategy === "nitter") {
    tweets = await collectTweetsViaNitter(query, limit);
    usedStrategy = "nitter";
  } else {
    tweets = await collectTweetsViaPlaywright(query, limit, authPath, headless);
    usedStrategy = "playwright";
  }

  const responseTimeMs = Date.now() - startTime;

  const accounts = summarizeAccounts(tweets);

  // Analyze tweets and accounts for bot signals
  const analyzedTweets = tweets.map((tweet) => {
    const account = accounts.get(tweet.authorHandle) || emptyAccount(tweet.authorHandle);
    const suspicion = scoreTweetSuspicion(tweet, account);
    return { ...tweet, isSuspicious: suspicion.score >= 50, suspicionScore: suspicion.score, suspicionReasons: suspicion.reasons };
  });

  const analyzedAccounts = Array.from(accounts.values()).map((account) => {
    const accountTweets = analyzedTweets.filter((tweet) => tweet.authorHandle === account.handle);
    const suspicion = scoreAccountSuspicion(account, accountTweets);
    return { ...account, botScore: suspicion.score, isBot: suspicion.score >= 60, isSubscriptionPromoter: suspicion.isSubscriptionPromoter, botReasons: suspicion.reasons };
  });

  // Update accounts map with analyzed data
  analyzedAccounts.forEach((account) => {
    accounts.set(account.handle, account);
  });

  const totalViews = analyzedTweets.reduce((sum, t) => sum + t.views, 0);
  const totalLikes = analyzedTweets.reduce((sum, t) => sum + t.likes, 0);
  const totalRetweets = analyzedTweets.reduce((sum, t) => sum + t.retweets, 0);
  const uniqueAccounts = accounts.size;
  const verifiedAccounts = analyzedAccounts.filter((a) => a.isVerified).length;
  const botAccounts = analyzedAccounts.filter((a) => a.isBot).length;

  const botScore = analyzedTweets.length || analyzedAccounts.length
    ? Math.round(((analyzedTweets.filter((t) => t.isSuspicious).length / Math.max(analyzedTweets.length, 1)) * 50) + ((botAccounts / Math.max(uniqueAccounts, 1)) * 50))
    : 0;

  const botRisk: "low" | "medium" | "high" = botScore >= 65 ? "high" : botScore >= 35 ? "medium" : "low";

  const result = {
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

export async function fetchTokenMeta(mint: string): Promise<{ twitter?: string; symbol?: string } | null> {
  const cached = TOKEN_META_CACHE.get(mint);
  if (cached && Date.now() - cached.ts < TOKEN_META_CACHE_TTL_MS) return cached.data;

  const endpoints = [
    `https://frontend-api-v3.pump.fun/coins/${encodeURIComponent(mint)}`,
    `https://frontend-api.pump.fun/coins/${encodeURIComponent(mint)}`,
  ];

  const attempts = endpoints.map(async (url) => {
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
        signal: AbortSignal.timeout(3500),
      });
      if (!r.ok) return null;
      const d = await r.json();
      return { twitter: normalizeTwitterHandle(d.twitter), symbol: d.symbol || undefined };
    } catch {
      return null;
    }
  });

  const results = await Promise.allSettled(attempts);
  const data = results
    .map((result) => result.status === "fulfilled" ? result.value : null)
    .find(Boolean) || null;
  TOKEN_META_CACHE.set(mint, { data, ts: Date.now() });
  return data;
}

export function buildQuery({ mint, symbol, tokenTwitterHandle, scope = "mentions" }: { mint?: string; symbol?: string; tokenTwitterHandle?: string; scope?: "mentions" | "official" }): string {
  const cleanHandle = normalizeTwitterHandle(tokenTwitterHandle);
  if (scope === "official") {
    return cleanHandle ? `from:${cleanHandle}` : "";
  }

  const parts = new Set<string>();
  const cleanSymbol = symbol?.trim().replace(/^\$/, "");
  const cleanMint = mint?.trim();
  if (cleanSymbol) {
    parts.add(`$${cleanSymbol}`);
    if (cleanSymbol.length > 2) parts.add(cleanSymbol);
  }
  if (cleanMint) parts.add(cleanMint);
  if (cleanHandle) parts.add(`@${cleanHandle}`);
  return Array.from(parts).slice(0, 4).join(" OR ");
}
