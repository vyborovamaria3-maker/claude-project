import type { Response } from "playwright";
import { getCollectorAccount } from "../src/x/account-session";
import { parseProxy } from "../src/x/proxy";
import { createBrowser } from "../src/x/client";
import { extractCookies } from "../src/x/session";
import { printDiagnostics } from "../src/x/diagnostics";
import { decryptBuffer } from "../lib/trade/crypto";
import { closePool } from "../lib/trade/pg";
import { getConfig } from "../lib/trade/config";

const HOME_URL = "https://x.com/home";

async function main() {
  const account = await getCollectorAccount();
  if (!account) {
    console.log("No active collector account");
    return;
  }
  console.log(`[x-account-test] account: ${account.name}`);

  const decrypted = decryptBuffer(account.session_encrypted);
  let cookies: ReturnType<typeof extractCookies>;
  try {
    cookies = extractCookies(decrypted);
  } finally {
    decrypted.fill(0);
  }

  const cfg = getConfig();
  const diag = { url: HOME_URL, httpStatus: 0 };
  const context = await createBrowser({
    cookies,
    proxy: parseProxy(account.proxy_json),
    userAgent: account.user_agent || undefined,
    timezone: account.timezone || undefined,
  });
  try {
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(cfg.twitter.requestTimeoutMs);

      let response: Response | null = null;
      try {
        response = await page.goto(HOME_URL, {
          waitUntil: "domcontentloaded",
          timeout: cfg.twitter.requestTimeoutMs,
        });
      } catch (e) {
        throw new Error(`X_NETWORK_ERROR: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }

      const status = response?.status() ?? 0;
      diag.httpStatus = status;
      diag.url = page.url() || HOME_URL;
      if (status >= 400) {
        if (status === 403 || status === 429 || status === 503) {
          throw new Error(`X_BLOCKED: HTTP ${status} (Cloudflare)`);
        }
        throw new Error(`X_NETWORK_ERROR: HTTP ${status}`);
      }

      await page.waitForTimeout(3000);

      diag.url = page.url();
      const pageUrl = page.url();
      const title = await page.title().catch(() => "");
      if (pageUrl.includes("/login") || pageUrl.includes("/i/flow/login") || /log in|sign in/i.test(title)) {
        throw new Error("AUTH_REQUIRED: session expired or invalid");
      }
      const bodyText = await page.locator("body").innerText().catch(() => "");
      if (/just a moment|cloudflare ray id/i.test(bodyText)) {
        throw new Error("X_BLOCKED: Cloudflare challenge");
      }
      console.log("X session OK");
    } catch (e) {
      printDiagnostics({
        error: e,
        url: diag.url,
        httpStatus: diag.httpStatus,
        account: account.name,
        proxyJson: account.proxy_json,
      }, "[x-account-test]");
      throw e;
    }
  } finally {
    const browser = context.browser();
    if (browser) await browser.close().catch(() => {});
    else await context.close().catch(() => {});
  }
}

main()
  .catch((e) => {
    console.error("[x-account-test] ошибка:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => {}));
