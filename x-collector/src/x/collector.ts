import { getConfig } from "../../lib/trade/config";
import { createBrowser } from "./client";
import { parseTweets } from "./parser";
import type { PlaywrightProxy } from "./proxy";
import type { XCookie } from "./client";
import type { XTweet } from "./types";
import { logger } from "../core/logger";
import { metrics } from "../core/metrics";

export interface SearchXOptions {
  cookies?: XCookie[];
  proxy?: PlaywrightProxy;
  userAgent?: string;
  timezone?: string;
  limit?: number;
}

/**
 * Поиск в X (f=live): browser context → goto → ожидание загрузки → парсер.
 * Ошибки классифицируются: AUTH_REQUIRED / X_BLOCKED / RATE_LIMIT / прочие HTTP.
 * Пустой результат не возвращается — это ошибка загрузки/блокировки.
 */
export async function searchX(query: string, options: SearchXOptions = {}): Promise<XTweet[]> {
  const cfg = getConfig();
  const url = `https://x.com/search?q=${encodeURIComponent(query)}&f=live`;
  logger.info("x search started", { query });
  const started = Date.now();

  let context: Awaited<ReturnType<typeof createBrowser>> | null = null;
  try {
    context = await createBrowser({
      cookies: options.cookies,
      proxy: options.proxy,
      userAgent: options.userAgent,
      timezone: options.timezone,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(cfg.twitter.requestTimeoutMs);

    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: cfg.twitter.requestTimeoutMs });
    const status = response?.status() ?? 0;
    if (status === 429) throw new Error("RATE_LIMIT: HTTP 429");
    if (status === 403 || status === 503) throw new Error(`X_BLOCKED: HTTP ${status}`);
    if (status >= 400) throw new Error(`X returned HTTP ${status} — запрос не прошёл`);

    try {
      await page.waitForSelector('article[data-testid="tweet"], [data-testid="emptyState"]', { timeout: 15_000 });
    } catch {
      /* не догрузилось — решают проверки ниже */
    }

    const pageUrl = page.url();
    if (pageUrl.includes("/login") || pageUrl.includes("/i/flow/login")) {
      throw new Error("AUTH_REQUIRED: search redirected to login — нужны cookies (npm run login)");
    }
    const title = await page.title().catch(() => "");
    const bodyText = await page.locator("body").innerText().catch(() => "");
    if (/just a moment|cloudflare ray id/i.test(`${title} ${bodyText}`)) {
      throw new Error("X_BLOCKED: Cloudflare challenge");
    }

    const tweets = await parseTweets(page, options.limit);
    if (tweets.length === 0) {
      throw new Error("EMPTY_RESULT: x search returned no tweets — страница не загрузилась или заблокирована");
    }

    metrics.xSearches++;
    metrics.tweetsCollected += tweets.length;
    logger.info("x tweets collected", { query, count: tweets.length, ms: Date.now() - started });
    return tweets;
  } catch (e) {
    metrics.collectorErrors++;
    logger.error("x search failed", { query, error: e instanceof Error ? e.message : String(e) });
    throw e;
  } finally {
    if (context) {
      const browser = context.browser();
      if (browser) await browser.close().catch(() => {});
      else await context.close().catch(() => {});
    }
  }
}
