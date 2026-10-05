import { chromium, Page, BrowserContextOptions } from "playwright";
import { getConfig } from "./config";

export interface RawTweet {
  id: string; text: string; authorHandle: string;
  authorDisplayName: string | null; url: string;
  views: number; likes: number; retweets: number; replies: number;
  isVerified: boolean; postedAt: number | null;
}

/** Формат in-memory storage state, который принимает Playwright. */
export type ScrapeAuthState = Exclude<BrowserContextOptions["storageState"], string>;

export interface ScrapeOptions {
  // Playwright accepts an in-memory storage state; do not write decrypted cookies to disk.
  authState: ScrapeAuthState;
  proxy?: { server: string; username?: string; password?: string };
  userAgent?: string;
  timezone?: string;
  headless?: boolean;
}

const BANNED_ERRORS = {
  login: /X login required|auth session expired/i,
  captcha: /verify you are human|are you a robot|unusual activity/i,
  limited: /temporarily limited your login|rate limit|429/i,
};

function detectError(pageUrl: string, pageText: string): string | null {
  let u: URL;
  try { u = new URL(pageUrl); } catch { return null; }
  const loginRedirect =
    u.pathname.includes("/login") ||
    u.pathname.includes("/i/flow/login") ||
    (u.pathname.includes("/i/jf/onboarding") && u.searchParams.get("mode") === "login");
  if (BANNED_ERRORS.limited.test(pageText)) return "rate limit: X temporarily limited this login";
  if (loginRedirect || BANNED_ERRORS.login.test(pageText)) return "X login required — session expired";
  if (BANNED_ERRORS.captcha.test(pageText)) return "captcha detected — manual verification needed";
  return null;
}

async function withBrowser<T>(opts: ScrapeOptions, fn: (page: Page) => Promise<T>): Promise<T> {
  const cfg = getConfig();
  const headless = opts.headless ?? cfg.twitter.headless;
  const deadline = Date.now() + cfg.twitter.collectionDeadlineMs;
  const browser = await chromium.launch({ headless, slowMo: headless ? 0 : 80 });
  try {
    const context = await browser.newContext({
      storageState: opts.authState,
      viewport: { width: 1365, height: 900 },
      locale: "en-US",
      userAgent: opts.userAgent ?? cfg.twitter.userAgents[0],
      ...(opts.timezone ? { timezoneId: opts.timezone } : {}),
      ...(opts.proxy ? { proxy: opts.proxy } : {}),
    });
    await context.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (t === "image" || t === "media" || t === "font") return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(Math.max(5_000, Math.min(cfg.twitter.requestTimeoutMs, deadline - Date.now())));
    // Общий дедлайн стратегии: даже если отдельные waitForSelector зависли,
    // вся операция укладывается в collectionDeadlineMs.
    return await Promise.race([
      fn(page),
      new Promise<T>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("collection deadline exceeded")),
          Math.max(1, deadline - Date.now()),
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    await browser.close();
  }
}

async function collectArticles(page: Page, limit: number, deadlineMs: number): Promise<RawTweet[]> {
  const seen = new Set<string>();
  const tweets: RawTweet[] = [];
  let stale = 0;

  while (tweets.length < limit && stale < 3) {
    // Общий дедлайн на весь скролл: страница не может «залипнуть» навсегда.
    if (Date.now() > deadlineMs) {
      if (tweets.length === 0) throw new Error("scrape deadline exceeded before any tweets were collected");
      break;
    }
    const batch = await page.locator('article[data-testid="tweet"]').evaluateAll(
      (articles) => articles.map((article): RawTweet | null => {
        const text = article.querySelector('[data-testid="tweetText"]')?.textContent?.trim() || '';
        if (!text) return null;
        const links = Array.from(article.querySelectorAll('a[href*="/status/"]'));
        const href = links.map((a) => a.getAttribute('href') || '').find((h) => /\/status\/\d+/.test(h)) || '';
        const id = (href.match(/\/status\/(\d+)/) || [])[1] || '';
        if (!id) return null;
        const parseMetric = (t: string | null | undefined): number => {
          if (!t) return 0;
          const m = String(t).replace(/\s+/g, '').match(/([0-9]+(?:[.,][0-9]+)?)([KMBКМБ]?)/i);
          if (!m) return 0;
          const s = (m[2] || '').toUpperCase();
          const v = Number(s ? m[1].replace(',', '.') : m[1].replace(/[.,]/g, ''));
          if (!isFinite(v)) return 0;
          if (s === 'K' || s === 'К') return Math.round(v * 1e3);
          if (s === 'M' || s === 'М') return Math.round(v * 1e6);
          if (s === 'B' || s === 'Б') return Math.round(v * 1e9);
          return Math.round(v);
        };
        const analyticsAria = article.querySelector('a[href$="/analytics"]')?.getAttribute('aria-label') || '';
        const fullText = article.textContent || '';
        const viewsMatch = analyticsAria.match(/([0-9.,]+[KMBКМБ]?)\s*(?:Views|просмотр)/i)
          || fullText.match(/([0-9.,]+[KMBКМБ]?)\s*(?:Views|просмотр|просмотров)/i);
        const timeAttr = article.querySelector('time')?.getAttribute('datetime') || null;
        return {
          id, text,
          authorHandle: href.split('/').filter(Boolean)[0] || 'unknown',
          authorDisplayName: article.querySelector('[data-testid="User-Name"] span')?.textContent?.trim() || null,
          url: `https://x.com${href.split('/analytics')[0]}`,
          views: parseMetric(viewsMatch?.[1]),
          likes: parseMetric(article.querySelector('[data-testid="like"]')?.textContent),
          retweets: parseMetric(article.querySelector('[data-testid="retweet"]')?.textContent),
          replies: parseMetric(article.querySelector('[data-testid="reply"]')?.textContent),
          isVerified: !!article.querySelector('[data-testid="icon-verified"]'),
          postedAt: timeAttr ? Date.parse(timeAttr) : null,
        };
      }).filter((t): t is RawTweet => t !== null)
    );

    const before = tweets.length;
    for (const t of batch) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      tweets.push(t);
      if (tweets.length >= limit) break;
    }
    stale = tweets.length === before ? stale + 1 : 0;

    if (tweets.length >= limit) break;
    await page.mouse.wheel(0, 1800);
    await page.waitForTimeout(500 + Math.random() * 500);
  }
  return tweets;
}

async function waitForTweetsOrEmpty(page: Page, timeoutMs: number): Promise<void> {
  // Таймаут не глотаем молча: если ни твитов, ни emptyState — страница, скорее
  // всего, не догрузилась, и это нужно отличить от «твитов действительно нет».
  try {
    await page.waitForSelector('article[data-testid="tweet"], [data-testid="emptyState"]', { timeout: timeoutMs });
  } catch {
    /* решает вызывающий код через состояние страницы */
  }
}

export async function searchTweets(
  query: string,
  opts: ScrapeOptions & { limit?: number; sort?: "top" | "latest" }
): Promise<RawTweet[]> {
  const cfg = getConfig();
  const limit = opts.limit ?? cfg.twitter.searchLimit;
  const sort = opts.sort ?? "latest";
  const mode = sort === "latest" ? "live" : "top";
  const url = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=${mode}`;

  return withBrowser(opts, async (page) => {
    const deadline = Date.now() + cfg.twitter.collectionDeadlineMs;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: cfg.twitter.requestTimeoutMs });
    await waitForTweetsOrEmpty(page, Math.min(15_000, cfg.twitter.requestTimeoutMs));
    const text = await page.locator("body").innerText().catch(() => "");
    const err = detectError(page.url(), text);
    if (err) throw new Error(err);
    const tweets = await collectArticles(page, limit, deadline);
    if (tweets.length === 0) {
      const hasEmptyState = await page.locator('[data-testid="emptyState"]').count() > 0;
      if (!hasEmptyState) throw new Error("search results did not load — no tweets and no empty state");
    }
    return tweets;
  });
}

export async function fetchUserTimeline(
  handle: string,
  opts: ScrapeOptions & { limit?: number }
): Promise<RawTweet[]> {
  const cfg = getConfig();
  const limit = opts.limit ?? cfg.twitter.timelineLimit;
  const url = `https://x.com/${handle}`;

  return withBrowser(opts, async (page) => {
    const deadline = Date.now() + cfg.twitter.collectionDeadlineMs;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: cfg.twitter.requestTimeoutMs });
    await waitForTweetsOrEmpty(page, Math.min(15_000, cfg.twitter.requestTimeoutMs));
    const text = await page.locator("body").innerText().catch(() => "");
    const err = detectError(page.url(), text);
    if (err) throw new Error(err);
    const tweets = await collectArticles(page, limit, deadline);
    if (tweets.length === 0) {
      const hasEmptyState = await page.locator('[data-testid="emptyState"]').count() > 0;
      if (!hasEmptyState) throw new Error("empty timeline — possibly shadowbanned session");
    }
    return tweets;
  });
}

export interface AccountProfileData {
  handle: string; displayName: string | null; bio: string | null;
  followers: number | null; following: number | null; postsCount: number | null;
  isVerified: boolean; joinedAt: number | null; avatarUrl: string | null;
}

export async function fetchAccountProfile(
  handle: string, opts: ScrapeOptions
): Promise<AccountProfileData> {
  const cfg = getConfig();
  return withBrowser(opts, async (page) => {
    await page.goto(`https://x.com/${handle}`, { waitUntil: "domcontentloaded", timeout: cfg.twitter.requestTimeoutMs });
    await page.waitForTimeout(3000);
    const err = detectError(page.url(), await page.locator("body").innerText().catch(() => ""));
    if (err) throw new Error(err);

    return page.evaluate((h) => {
      const text = (sel: string) => document.querySelector(sel)?.textContent?.trim() ?? null;
      const parseNum = (s: string | null): number | null => {
        if (!s) return null;
        const m = s.replace(/\s/g, "").match(/([0-9][0-9.,]*)([KMBКМБ]?)/i);
        if (!m) return null;
        const suf = (m[2] || "").toUpperCase();
        // Without a compact suffix, punctuation in X's counters is a thousands separator.
        const v = Number(suf ? m[1].replace(",", ".") : m[1].replace(/[.,]/g, ""));
        if (suf === "K" || suf === "К") return Math.round(v * 1e3);
        if (suf === "M" || suf === "М") return Math.round(v * 1e6);
        if (suf === "B" || suf === "Б") return Math.round(v * 1e9);
        return Math.round(v);
      };
      const followersLink = document.querySelector(`a[href="/${h}/verified_followers"], a[href="/${h}/followers"]`);
      const followingLink = document.querySelector(`a[href="/${h}/following"]`);
      const joined = text('[data-testid="UserProfileHeader_Items"] a[href*="/joined"]');
      return {
        handle: h,
        displayName: text('[data-testid="UserName"] span'),
        bio: text('[data-testid="UserDescription"]'),
        followers: parseNum(followersLink?.textContent ?? null),
        following: parseNum(followingLink?.textContent ?? null),
        postsCount: null as number | null,
        isVerified: !!document.querySelector('[data-testid="icon-verified"]'),
        joinedAt: joined ? (Date.parse(joined.replace(/^Joined\s+/i, "")) || null) : null,
        avatarUrl: (document.querySelector('img[src*="profile_images"]') as HTMLImageElement | null)?.src ?? null,
      };
    }, handle);
  });
}

