import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { chromium } from "playwright";

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

const args = parseArgs(process.argv.slice(2));
const root = process.cwd();
const dbPath = path.join(root, "data", "twitter-research.db");
const defaultAuthPath = path.join(root, "data", "x-auth", "storage-state.json");

if (args.help || (!args.mint && !args.symbol && !args.query)) {
  printHelp();
  process.exit(args.help ? 0 : 1);
}

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
initDb(db);

const mint = String(args.mint || "").trim();
const explicitSymbol = String(args.symbol || "").replace(/^\$/, "").trim();
const explicitTwitter = normalizeHandle(String(args.twitter || ""));
const authPath = String(args.auth || defaultAuthPath);
const useAuth = fs.existsSync(authPath);
const limit = clamp(Number(args.limit || 40), 5, 120);
const headless = args.headful ? false : true;

const tokenMeta = mint ? await fetchTokenMeta(mint).catch(() => null) : null;
const symbol = explicitSymbol || tokenMeta?.symbol || "";
const tokenTwitterHandle = explicitTwitter || normalizeHandle(tokenMeta?.twitter || "");
const rawQuery = args.query === true ? "" : String(args.query || "");
const query = String(rawQuery || buildQuery({ mint, symbol, tokenTwitterHandle })).trim();

if (!query) {
  console.error("Search query is empty. Use --symbol <SYMBOL>, --mint <CA>, or --query '<query>'.");
  console.error("PowerShell note: use single quotes for cashtags, for example --query '$WWE'.");
  process.exit(1);
}

console.log("Twitter/X manipulation analysis");
console.log(`mint: ${mint || "-"}`);
console.log(`symbol: ${symbol || "-"}`);
console.log(`token twitter: ${tokenTwitterHandle || "-"}`);
console.log(`query: ${query}`);
console.log(`auth: ${useAuth ? authPath : "not found, public session"}`);

const browser = await chromium.launch({ headless, slowMo: headless ? 0 : 80 });
const context = await browser.newContext({
  storageState: useAuth ? authPath : undefined,
  viewport: { width: 1365, height: 900 },
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
});
const page = await context.newPage();

let tweets = [];
try {
  tweets = await collectTweets(page, query, limit);
} finally {
  await browser.close();
}

const accounts = summarizeAccounts(tweets);
const analyzedTweets = tweets.map((tweet) => {
  const account = accounts.get(tweet.authorHandle) || emptyAccount(tweet.authorHandle);
  const suspicion = scoreTweetSuspicion(tweet, account);
  return { ...tweet, isSuspicious: suspicion.score >= 50, suspicionScore: suspicion.score, suspicionReasons: suspicion.reasons };
});

const analyzedAccounts = Array.from(accounts.values()).map((account) => {
  const suspicion = scoreAccountSuspicion(account, analyzedTweets.filter((tweet) => tweet.authorHandle === account.handle));
  return { ...account, botScore: suspicion.score, isBot: suspicion.score >= 60, isSubscriptionPromoter: suspicion.isSubscriptionPromoter, botReasons: suspicion.reasons };
});

persistResults({ db, mint, symbol, tokenTwitterHandle, query, tweets: analyzedTweets, accounts: analyzedAccounts });
const report = buildReport({ mint, symbol, tokenTwitterHandle, query, tweets: analyzedTweets, accounts: analyzedAccounts });

console.log(JSON.stringify(report, null, 2));
console.log(`Saved to ${dbPath}`);

db.close();

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out[key] = true;
    else out[key] = argv[++i];
  }
  return out;
}

function printHelp() {
  console.log(`Usage:
  node scripts/analyze-twitter-manipulation.mjs --mint <CA> --symbol <SYMBOL> [--twitter <handle>] [--limit 40]
  node scripts/analyze-twitter-manipulation.mjs --query '($WWE OR CA)' --limit 30
  node scripts/analyze-twitter-manipulation.mjs --mint <CA> --headful

Before authenticated scraping:
  node scripts/x-login.mjs

Notes:
  - Views are best-effort. X may hide them or block public sessions.
  - Keep data/x-auth/storage-state.json private.
`);
}

function initDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS twitter_token_analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT,
      symbol TEXT,
      token_twitter_handle TEXT,
      query TEXT NOT NULL,
      total_tweets INTEGER NOT NULL DEFAULT 0,
      total_views INTEGER NOT NULL DEFAULT 0,
      total_likes INTEGER NOT NULL DEFAULT 0,
      total_retweets INTEGER NOT NULL DEFAULT 0,
      unique_accounts INTEGER NOT NULL DEFAULT 0,
      verified_accounts INTEGER NOT NULL DEFAULT 0,
      bot_accounts INTEGER NOT NULL DEFAULT 0,
      excluded_bot_accounts INTEGER NOT NULL DEFAULT 0,
      avg_views REAL,
      avg_likes REAL,
      avg_retweets REAL,
      bot_manipulation_score REAL NOT NULL DEFAULT 0,
      bot_manipulation_risk TEXT NOT NULL DEFAULT 'low',
      analyzed_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS twitter_token_tweets (
      tweet_id TEXT PRIMARY KEY,
      mint TEXT,
      symbol TEXT,
      author_handle TEXT NOT NULL,
      text TEXT NOT NULL,
      url TEXT,
      views INTEGER NOT NULL DEFAULT 0,
      likes INTEGER NOT NULL DEFAULT 0,
      retweets INTEGER NOT NULL DEFAULT 0,
      replies INTEGER NOT NULL DEFAULT 0,
      is_verified INTEGER NOT NULL DEFAULT 0,
      is_suspicious INTEGER NOT NULL DEFAULT 0,
      suspicion_score REAL NOT NULL DEFAULT 0,
      suspicion_reasons TEXT NOT NULL DEFAULT '[]',
      posted_at INTEGER,
      fetched_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS twitter_accounts (
      handle TEXT PRIMARY KEY,
      display_name TEXT,
      followers INTEGER,
      following INTEGER,
      posts_count INTEGER,
      is_verified INTEGER NOT NULL DEFAULT 0,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      bot_score REAL NOT NULL DEFAULT 0,
      is_bot INTEGER NOT NULL DEFAULT 0,
      is_subscription_promoter INTEGER NOT NULL DEFAULT 0,
      bot_reasons TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS twitter_token_shillers (
      mint TEXT NOT NULL,
      handle TEXT NOT NULL,
      tweets_count INTEGER NOT NULL DEFAULT 0,
      total_views INTEGER NOT NULL DEFAULT 0,
      total_likes INTEGER NOT NULL DEFAULT 0,
      total_retweets INTEGER NOT NULL DEFAULT 0,
      avg_views REAL,
      avg_likes REAL,
      avg_retweets REAL,
      is_verified INTEGER NOT NULL DEFAULT 0,
      is_bot INTEGER NOT NULL DEFAULT 0,
      is_excluded INTEGER NOT NULL DEFAULT 0,
      first_tweeted_at INTEGER,
      last_tweeted_at INTEGER,
      PRIMARY KEY (mint, handle)
    );

    CREATE INDEX IF NOT EXISTS idx_twitter_analyses_mint ON twitter_token_analyses(mint, analyzed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_twitter_tweets_mint ON twitter_token_tweets(mint, fetched_at DESC);
    CREATE INDEX IF NOT EXISTS idx_twitter_shillers_mint ON twitter_token_shillers(mint, total_views DESC);
  `);
}

async function fetchTokenMeta(mint) {
  const r = await fetch(`https://frontend-api.pump.fun/coins/${encodeURIComponent(mint)}`, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) return null;
  const d = await r.json();
  return { symbol: d.symbol || null, twitter: d.twitter || null };
}

function buildQuery({ mint, symbol, tokenTwitterHandle }) {
  const parts = [];
  if (symbol) parts.push(`$${symbol}`, symbol);
  if (mint) parts.push(mint);
  if (tokenTwitterHandle) parts.push(`@${tokenTwitterHandle}`);
  return parts.slice(0, 4).join(" OR ");
}

async function collectTweets(page, query, limit) {
  const searchUrl = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`;
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(5000);

  const seen = new Set();
  const tweets = [];
  let staleRounds = 0;

  while (tweets.length < limit && staleRounds < 8) {
    const batch = await page.locator('article[data-testid="tweet"]').evaluateAll((articles) => {
      const parseMetric = (text) => {
        if (!text) return 0;
        const cleaned = text.replace(/\s+/g, "").trim();
        const match = cleaned.match(/([0-9]+(?:[.,][0-9]+)?)([KMBКМБ]?)/i);
        if (!match) return 0;
        const suffix = match[2]?.toUpperCase();
        const numeric = suffix ? match[1].replace(",", ".") : match[1].replace(/[.,]/g, "");
        const value = Number(numeric);
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
        const analyticsText = article.querySelector('a[href$="/analytics"]')?.textContent || "";
        const aria = article.textContent || "";
        const viewsMatch = analyticsText || (aria.match(/([0-9.,]+[KMBКМБ]?)\s*(?:Views|просмотр|просмотров)/i)?.[1] || "");
        const views = parseMetric(viewsMatch);
        return { id, text, authorHandle, url, views, likes: like, retweets: retweet, replies: reply, isVerified, postedAt: time ? Date.parse(time) : null };
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
    await page.waitForTimeout(1800 + Math.floor(Math.random() * 900));
  }

  return tweets;
}

function summarizeAccounts(tweets) {
  const map = new Map();
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

function emptyAccount(handle) {
  return { handle, displayName: null, followers: null, following: null, postsCount: null, isVerified: false, tweetsCount: 0, totalViews: 0, totalLikes: 0, totalRetweets: 0, firstTweetedAt: null, lastTweetedAt: null };
}

function scoreTweetSuspicion(tweet, account) {
  let score = 0;
  const reasons = [];
  const views = Math.max(tweet.views || 0, 1);
  const likeRate = (tweet.likes || 0) / views;
  const rtRate = (tweet.retweets || 0) / views;

  if (tweet.views > 0 && likeRate > 0.12) { score += 25; reasons.push("very_high_like_view_ratio"); }
  if (tweet.views > 0 && rtRate > 0.06) { score += 25; reasons.push("very_high_retweet_view_ratio"); }
  if ((tweet.retweets || 0) > Math.max((tweet.likes || 0) * 2, 10)) { score += 20; reasons.push("retweets_much_higher_than_likes"); }
  if (/\b(100x|gem|moon|send it|don't fade|ca:|contract)\b/i.test(tweet.text)) { score += 10; reasons.push("promo_language"); }
  if (subscriptionPatterns.some((p) => p.test(tweet.text))) { score += 40; reasons.push("subscription_promoter_text"); }
  if (!account.isVerified && account.tweetsCount > 3) { score += 10; reasons.push("repeated_unverified_mentions"); }

  return { score: Math.min(score, 100), reasons };
}

function scoreAccountSuspicion(account, tweets) {
  let score = 0;
  const reasons = [];
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

  return { score: Math.min(score, 100), reasons, isSubscriptionPromoter };
}

function persistResults({ db, mint, symbol, tokenTwitterHandle, query, tweets, accounts }) {
  const now = Date.now();
  const uniqueAccounts = accounts.length;
  const verifiedAccounts = accounts.filter((a) => a.isVerified).length;
  const botAccounts = accounts.filter((a) => a.isBot).length;
  const excludedBotAccounts = accounts.filter((a) => a.isSubscriptionPromoter).length;
  const totalViews = sum(tweets, "views");
  const totalLikes = sum(tweets, "likes");
  const totalRetweets = sum(tweets, "retweets");
  const botScore = tweets.length || accounts.length
    ? Math.round(((tweets.filter((t) => t.isSuspicious).length / Math.max(tweets.length, 1)) * 50) + ((botAccounts / Math.max(uniqueAccounts, 1)) * 50))
    : 0;
  const risk = botScore >= 65 ? "high" : botScore >= 35 ? "medium" : "low";

  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO twitter_token_analyses
      (mint, symbol, token_twitter_handle, query, total_tweets, total_views, total_likes, total_retweets, unique_accounts, verified_accounts, bot_accounts, excluded_bot_accounts, avg_views, avg_likes, avg_retweets, bot_manipulation_score, bot_manipulation_risk, analyzed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(mint || null, symbol || null, tokenTwitterHandle || null, query, tweets.length, totalViews, totalLikes, totalRetweets, uniqueAccounts, verifiedAccounts, botAccounts, excludedBotAccounts, avg(totalViews, tweets.length), avg(totalLikes, tweets.length), avg(totalRetweets, tweets.length), botScore, risk, now);

    const tweetStmt = db.prepare(`INSERT INTO twitter_token_tweets
      (tweet_id, mint, symbol, author_handle, text, url, views, likes, retweets, replies, is_verified, is_suspicious, suspicion_score, suspicion_reasons, posted_at, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tweet_id) DO UPDATE SET views=excluded.views, likes=excluded.likes, retweets=excluded.retweets, replies=excluded.replies, is_suspicious=excluded.is_suspicious, suspicion_score=excluded.suspicion_score, suspicion_reasons=excluded.suspicion_reasons, fetched_at=excluded.fetched_at`);

    for (const tweet of tweets) {
      tweetStmt.run(tweet.id, mint || null, symbol || null, tweet.authorHandle, tweet.text, tweet.url, tweet.views || 0, tweet.likes || 0, tweet.retweets || 0, tweet.replies || 0, tweet.isVerified ? 1 : 0, tweet.isSuspicious ? 1 : 0, tweet.suspicionScore || 0, JSON.stringify(tweet.suspicionReasons || []), tweet.postedAt || null, now);
    }

    const accountStmt = db.prepare(`INSERT INTO twitter_accounts
      (handle, display_name, followers, following, posts_count, is_verified, first_seen_at, last_seen_at, bot_score, is_bot, is_subscription_promoter, bot_reasons)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(handle) DO UPDATE SET is_verified=max(is_verified, excluded.is_verified), last_seen_at=excluded.last_seen_at, bot_score=excluded.bot_score, is_bot=excluded.is_bot, is_subscription_promoter=excluded.is_subscription_promoter, bot_reasons=excluded.bot_reasons`);

    const shillerStmt = db.prepare(`INSERT INTO twitter_token_shillers
      (mint, handle, tweets_count, total_views, total_likes, total_retweets, avg_views, avg_likes, avg_retweets, is_verified, is_bot, is_excluded, first_tweeted_at, last_tweeted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(mint, handle) DO UPDATE SET tweets_count=excluded.tweets_count, total_views=excluded.total_views, total_likes=excluded.total_likes, total_retweets=excluded.total_retweets, avg_views=excluded.avg_views, avg_likes=excluded.avg_likes, avg_retweets=excluded.avg_retweets, is_verified=excluded.is_verified, is_bot=excluded.is_bot, is_excluded=excluded.is_excluded, first_tweeted_at=excluded.first_tweeted_at, last_tweeted_at=excluded.last_tweeted_at`);

    for (const account of accounts) {
      accountStmt.run(account.handle, account.displayName, account.followers, account.following, account.postsCount, account.isVerified ? 1 : 0, now, now, account.botScore || 0, account.isBot ? 1 : 0, account.isSubscriptionPromoter ? 1 : 0, JSON.stringify(account.botReasons || []));
      if (mint) {
        shillerStmt.run(mint, account.handle, account.tweetsCount, account.totalViews, account.totalLikes, account.totalRetweets, avg(account.totalViews, account.tweetsCount), avg(account.totalLikes, account.tweetsCount), avg(account.totalRetweets, account.tweetsCount), account.isVerified ? 1 : 0, account.isBot ? 1 : 0, account.isSubscriptionPromoter ? 1 : 0, account.firstTweetedAt || null, account.lastTweetedAt || null);
      }
    }
  });

  tx();
}

function buildReport({ mint, symbol, tokenTwitterHandle, query, tweets, accounts }) {
  const totalViews = sum(tweets, "views");
  const totalLikes = sum(tweets, "likes");
  const totalRetweets = sum(tweets, "retweets");
  const botAccounts = accounts.filter((a) => a.isBot).length;
  const botScore = tweets.length || accounts.length
    ? Math.round(((tweets.filter((t) => t.isSuspicious).length / Math.max(tweets.length, 1)) * 50) + ((botAccounts / Math.max(accounts.length, 1)) * 50))
    : 0;

  return {
    mint: mint || null,
    symbol: symbol || null,
    tokenTwitterHandle: tokenTwitterHandle || null,
    query,
    totalTweets: tweets.length,
    totalViews,
    totalLikes,
    totalRetweets,
    avgViews: avg(totalViews, tweets.length),
    avgLikes: avg(totalLikes, tweets.length),
    avgRetweets: avg(totalRetweets, tweets.length),
    uniqueAccounts: accounts.length,
    verifiedAccounts: accounts.filter((a) => a.isVerified).length,
    botAccounts,
    excludedSubscriptionPromoters: accounts.filter((a) => a.isSubscriptionPromoter).length,
    botManipulationScore: botScore,
    risk: botScore >= 65 ? "high" : botScore >= 35 ? "medium" : "low",
    topShillers: accounts
      .sort((a, b) => (b.totalViews + b.totalLikes + b.totalRetweets) - (a.totalViews + a.totalLikes + a.totalRetweets))
      .slice(0, 15)
      .map((a) => ({ handle: a.handle, tweets: a.tweetsCount, views: a.totalViews, likes: a.totalLikes, retweets: a.totalRetweets, verified: a.isVerified, botScore: a.botScore, excluded: a.isSubscriptionPromoter })),
  };
}

function normalizeHandle(value) {
  return String(value || "").trim().replace(/^https?:\/\/(x|twitter)\.com\//i, "").replace(/^@/, "").split(/[/?#]/)[0];
}

function sum(rows, key) {
  return rows.reduce((acc, row) => acc + (Number(row[key]) || 0), 0);
}

function avg(total, count) {
  return count > 0 ? Math.round((total / count) * 100) / 100 : 0;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
