import { chromium, BrowserContext } from "playwright";
import { getConfig } from "../../lib/trade/config";
import type { PlaywrightProxy } from "./proxy";

export type XCookie = Parameters<BrowserContext["addCookies"]>[0][number];

export interface BrowserOptions {
  cookies?: XCookie[];
  proxy?: PlaywrightProxy;
  userAgent?: string;
  timezone?: string;
  language?: string;
}

/**
 * Запускает chromium и возвращает готовый BrowserContext.
 * Владелец браузера — вызывающий код: закрывайте через context.browser()?.close().
 */
export async function createBrowser(options: BrowserOptions = {}): Promise<BrowserContext> {
  const cfg = getConfig();
  const headless = cfg.twitter.headless;
  const browser = await chromium.launch({ headless, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, slowMo: headless ? 0 : 80 });
  try {
    const context = await browser.newContext({
      viewport: { width: 1365, height: 900 },
      locale: options.language || "en-US",
      userAgent: options.userAgent || cfg.twitter.userAgents[0],
      ...(options.proxy ? { proxy: options.proxy } : {}),
      ...(options.timezone ? { timezoneId: options.timezone } : {}),
    });
    await context.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (t === "image" || t === "media" || t === "font") return route.abort();
      return route.continue();
    });
    // tsx компилирует скрипты esbuild'ом с keepNames, поэтому локальные функции
    // внутри page.evaluate/evaluateAll превращаются в __name(fn, "имя").
    // Callback сериализуется Function.prototype.toString() и выполняется в браузере,
    // где __name не определён → ReferenceError → все твиты отбрасываются (EMPTY_RESULT).
    // Инжектим совместимый helper до любых скриптов страницы.
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
    if (options.cookies && options.cookies.length > 0) await context.addCookies(options.cookies);
    return context;
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }
}
