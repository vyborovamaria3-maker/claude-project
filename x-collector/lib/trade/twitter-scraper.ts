import type { Progress } from "../collector/live";
import { chromium, Page, BrowserContextOptions } from "playwright";
import { getConfig } from "./config";
import { collectionUrl } from "./list-source";

export interface RawTweet {
  id: string; text: string; authorHandle: string;
  authorDisplayName: string | null; url: string;
  views: number | null; likes: number | null; retweets: number | null; replies: number | null;
  observedAt: number; links: string[]; mentions: string[]; hashtags: string[];
  media: {type:"photo"|"video";url:string|null}[]; relatedPostIds: string[];
  isVerified: boolean; postedAt: number | null;
}

/** Формат in-memory storage state, который принимает Playwright. */
export type ScrapeAuthState = Exclude<BrowserContextOptions["storageState"], string>;

export interface ScrapeOptions {
  // Playwright accepts an in-memory storage state; do not write decrypted cookies to disk.
  authState: ScrapeAuthState;
  signal?: AbortSignal;
  onProgress?: (progress:Progress)=>Promise<void>;
  onBatch?: (tweets:RawTweet[])=>Promise<void>;
  proxy?: { server: string; username?: string; password?: string };
  userAgent?: string;
  timezone?: string;
  language?: string;
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
  if(opts.signal?.aborted)throw new Error("collection cancelled");
  const cfg = getConfig();
  const headless = opts.headless ?? cfg.twitter.headless;
  const deadline = Date.now() + cfg.twitter.collectionDeadlineMs;
  let running:Promise<T>|undefined;
  const browser = await chromium.launch({ headless, executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, slowMo: headless ? 0 : 80 });
  try {
    const context = await browser.newContext({
      storageState: opts.authState,
      viewport: { width: 1365, height: 900 },
      locale: opts.language || "en-US",
      userAgent: opts.userAgent ?? cfg.twitter.userAgents[0],
      ...(opts.timezone ? { timezoneId: opts.timezone } : {}),
      ...(opts.proxy ? { proxy: opts.proxy } : {}),
    });
    await context.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (t === "image" || t === "media" || t === "font") return route.abort();
      return route.continue();
    });
    // tsx/esbuild keepNames injects __name(...) into evaluate callbacks; the browser
    // has no such helper, so without this shim every parsed item throws and is dropped.
    await context.addInitScript({
      content: [
        "if (typeof globalThis.__name !== 'function') {",
        "  globalThis.__name = function (target, value) {",
        "    try { Object.defineProperty(target, 'name', { value: value, configurable: true }); } catch (e) {}",
        "    return target;",
        "  };",
        "}",
      ].join("\n"),
    });
    const page = await context.newPage();
    page.setDefaultTimeout(Math.max(5_000, Math.min(cfg.twitter.requestTimeoutMs, deadline - Date.now())));
    let deadlineTimer: NodeJS.Timeout | undefined;
    let abortHandler: (()=>void)|undefined;
    try {
    // Общий дедлайн стратегии: даже если отдельные waitForSelector зависли,
    // вся операция укладывается в collectionDeadlineMs.
    return await Promise.race([
      running=fn(page),
      new Promise<T>((_,reject)=>{abortHandler=()=>reject(new Error("collection cancelled"));opts.signal?.addEventListener("abort",abortHandler,{once:true});if(opts.signal?.aborted)abortHandler();}),
      new Promise<T>((_, reject) => {
        deadlineTimer = setTimeout(
          () => reject(new Error("collection deadline exceeded")),
          Math.max(1, deadline - Date.now()),
        );
        deadlineTimer.unref?.();
      }),
    ]);
    } finally { if (deadlineTimer) clearTimeout(deadlineTimer); if(abortHandler)opts.signal?.removeEventListener("abort",abortHandler); }
  } finally {
    await browser.close();
    // Drain an in-flight persistence callback before the caller requeues a timed-out task.
    await running?.catch(()=>{});
  }
}

export function extractTweetArticles(articles: Element[]): RawTweet[] {
  return articles.map((article): RawTweet | null => {
        const text = article.querySelector('[data-testid="tweetText"]')?.textContent?.trim() || '';

        const links = Array.from(article.querySelectorAll('a[href*="/status/"]'));
        const href = article.querySelector('time')?.closest('a[href*="/status/"]')?.getAttribute('href') || '';
        const id = (href.match(/\/status\/(\d+)/) || [])[1] || '';
        if (!id) return null;
        const metricParser = { parse(t: string | null | undefined): number | null {
          if (!t) return null;
          const m = String(t).replace(/\s+/g, '').match(/([0-9][0-9.,]*)([KMBКМБ]?)/i);
          if (!m) return null;
          const s = (m[2] || '').toUpperCase();
          const v = Number(s ? m[1].replace(',', '.') : m[1].replace(/[.,]/g, ''));
          if (!isFinite(v)) return null;
          if (s === 'K' || s === 'К') return Math.round(v * 1e3);
          if (s === 'M' || s === 'М') return Math.round(v * 1e6);
          if (s === 'B' || s === 'Б') return Math.round(v * 1e9);
          return Math.round(v);
        } };
        const parseMetric = metricParser.parse;
        const analyticsAria = article.querySelector('a[href$="/analytics"]')?.getAttribute('aria-label') || '';
        const fullText = article.textContent || '';
        const viewsMatch = analyticsAria.match(/([0-9.,]+[KMBКМБ]?)\s*(?:Views|просмотр)/i)
          || fullText.match(/([0-9.,]+[KMBКМБ]?)\s*(?:Views|просмотр|просмотров)/i);
        const allLinks = Array.from(article.querySelectorAll('a[href]')).map(a=>a.getAttribute('href')!).filter(Boolean);
        const controls = { metric(selector:string) { const el=article.querySelector(selector); return parseMetric(el?.getAttribute('aria-label') || el?.textContent); } };
        const timeAttr = article.querySelector('time')?.getAttribute('datetime') || null;
        return {
          id, text, observedAt:Date.now(),
          links:[...new Set(allLinks.filter(h=>/^https?:\/\//.test(h)))],
          mentions:[...new Set(Array.from(text.matchAll(/(?:^|\s)@([A-Za-z0-9_]{1,15})\b/g),m=>m[1]))],
          hashtags:[...new Set(Array.from(text.matchAll(/(?:^|\s)#([\p{L}\p{N}_]+)/gu),m=>m[1]))],
          relatedPostIds:[...new Set(links.map(a=>a.getAttribute('href')?.match(/\/status\/(\d+)/)?.[1]).filter((v):v is string=>Boolean(v)&&v!==id))],
          media:Array.from(article.querySelectorAll('[data-testid="tweetPhoto"] img,video')).map(el=>({type:el.tagName==='VIDEO'?'video' as const:'photo' as const,url:el.getAttribute('src')||el.getAttribute('poster')||null})),
          authorHandle: Array.from(article.querySelectorAll('[data-testid="User-Name"] a[href]')).map(a=>a.getAttribute('href')?.match(/^\/([A-Za-z0-9_]{1,15})$/)?.[1]).find(Boolean) || href.match(/^\/([A-Za-z0-9_]{1,15})\/status\//)?.[1] || 'unknown',
          authorDisplayName: article.querySelector('[data-testid="User-Name"] span')?.textContent?.trim() || null,
          url: `https://x.com${href.split('/analytics')[0]}`,
          views: parseMetric(viewsMatch?.[1]),
          likes: controls.metric('[data-testid="like"], [data-testid="unlike"]'),
          retweets: controls.metric('[data-testid="retweet"], [data-testid="unretweet"]'),
          replies: controls.metric('[data-testid="reply"]'),
          isVerified: !!article.querySelector('[data-testid="icon-verified"]'),
          postedAt: timeAttr ? Date.parse(timeAttr) : null,
        };
      }).filter((t): t is RawTweet => t !== null);
}

export async function collectArticles(page: Page, limit: number, deadlineMs: number, onProgress?:ScrapeOptions["onProgress"], onBatch?:ScrapeOptions["onBatch"]): Promise<RawTweet[]> {
  const seen = new Set<string>();
  const tweets: RawTweet[] = [];
  let stale = 0;

  while (tweets.length < limit && stale < 3) {
    // Общий дедлайн на весь скролл: страница не может «залипнуть» навсегда.
    if (Date.now() > deadlineMs) {
      if (tweets.length === 0) throw new Error("scrape deadline exceeded before any tweets were collected");
      break;
    }
    const pageError = detectError(page.url(), await page.locator("body").innerText().catch(()=>""));
    if (pageError) throw new Error(pageError);
    const batch = await page.locator('article[data-testid="tweet"]').evaluateAll(
      extractTweetArticles
    );

    const before = tweets.length;
    for (const t of batch) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      tweets.push(t);
      if (tweets.length >= limit) break;
    }
    stale = tweets.length === before ? stale + 1 : 0;
    await onProgress?.({phase:"collecting",found:tweets.length,limit,authors:[...new Set(tweets.map(t=>t.authorHandle))],currentAuthor:tweets.at(-1)?.authorHandle??null});

    if(tweets.length>before)await onBatch?.(tweets.slice(before));
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
  const url = collectionUrl(query, sort);

  return withBrowser(opts, async (page) => {
    const deadline = Date.now() + cfg.twitter.collectionDeadlineMs;
    await opts.onProgress?.({phase:"opening",limit});
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: cfg.twitter.requestTimeoutMs });
    await waitForTweetsOrEmpty(page, Math.min(15_000, cfg.twitter.requestTimeoutMs));
    const text = await page.locator("body").innerText().catch(() => "");
    const err = detectError(page.url(), text);
    if (err) throw new Error(err);
    const tweets = await collectArticles(page, limit, deadline, opts.onProgress,opts.onBatch);
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
    await opts.onProgress?.({phase:"opening",limit});
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: cfg.twitter.requestTimeoutMs });
    await waitForTweetsOrEmpty(page, Math.min(15_000, cfg.twitter.requestTimeoutMs));
    const text = await page.locator("body").innerText().catch(() => "");
    const err = detectError(page.url(), text);
    if (err) throw new Error(err);
    const tweets = await collectArticles(page, limit, deadline, opts.onProgress,opts.onBatch);
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
    await opts.onProgress?.({phase:"profile",currentAuthor:handle});
    await page.goto(`https://x.com/${handle}`, { waitUntil: "domcontentloaded", timeout: cfg.twitter.requestTimeoutMs });
    await page.waitForSelector('[data-testid="UserName"], [data-testid="emptyState"], [data-testid="error-detail"]', {timeout:Math.min(15000,cfg.twitter.requestTimeoutMs)}).catch(()=>{});
    const err = detectError(page.url(), await page.locator("body").innerText().catch(() => ""));
    if (err) throw new Error(err);

    if (!await page.locator('[data-testid="UserName"]').count()) throw new Error("profile did not load or is unavailable");
    return page.evaluate((h) => {
      const dom = { text(sel:string) { return document.querySelector(sel)?.textContent?.trim() ?? null; } };
      const text = dom.text;
      const numbers = { parse(s: string | null): number | null {
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
      } };
      const parseNum = numbers.parse;
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

