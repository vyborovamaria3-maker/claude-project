import { chromium } from "playwright";
import { q1, closePool } from "../lib/trade/pg";
import { decryptBuffer } from "../lib/trade/crypto";
import { getConfig } from "../lib/trade/config";
import { getCollectorAccount, CollectorAccount } from "../src/x/account-session";
import { extractCookies } from "../src/x/session";
import { createBrowser, XCookie } from "../src/x/client";
import { parseProxy } from "../src/x/proxy";
import { proxyStatus } from "../src/x/diagnostics";

const TAG = "[x-health]";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

interface Ctx {
  account: CollectorAccount | null;
  cookies: XCookie[] | null;
}

const results: Check[] = [];

async function run(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`${TAG} OK   ${name} — ${detail}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const cause = e instanceof Error && e.cause instanceof Error ? ` (cause: ${e.cause.message})` : "";
    results.push({ name, ok: false, detail: `${msg}${cause}` });
    console.error(`${TAG} FAIL ${name} — ${msg}${cause}`);
  }
}

async function main() {
  console.log(`${TAG} start`);
  const ctx: Ctx = { account: null, cookies: null };

  await run("Database OK", async () => {
    const r = await q1<{ db: string }>("SELECT current_database() AS db");
    return `connected, database=${r?.db ?? "?"}`;
  });

  await run("Account exists", async () => {
    const counts = await q1<{ total: number; active: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'active' AND tier != 'retired')::int AS active
       FROM x_accounts`
    );
    if (!counts || counts.total === 0) throw new Error("x_accounts is empty — npm run login -- <name>");
    const pickable = await getCollectorAccount();
    if (!pickable) throw new Error(`accounts=${counts.total}, pickable=0 (cooldown/busy/quota/status)`);
    ctx.account = pickable;
    return `total=${counts.total}, active=${counts.active}, pickable=${pickable.name} (proxy: ${proxyStatus(pickable.proxy_json)})`;
  });

  await run("Session decrypt OK", async () => {
    const acc = ctx.account;
    if (!acc) throw new Error("no pickable account");
    const decrypted = decryptBuffer(acc.session_encrypted);
    let parsed: XCookie[];
    try {
      parsed = extractCookies(decrypted);
    } finally {
      decrypted.fill(0);
    }
    ctx.cookies = parsed;
    const xCookies = parsed.filter((c) => (c.domain ?? "").includes("x.com") || (c.domain ?? "").includes("twitter.com"));
    if (parsed.length === 0) throw new Error("session decrypted but contains no cookies");
    return `account=${acc.name}, cookies=${parsed.length} (x.com=${xCookies.length}), secrets not printed`;
  });

  await run("Browser launch OK", async () => {
    const cfg = getConfig();
    const browser = await chromium.launch({ headless: cfg.twitter.headless });
    try {
      return `chromium ${browser.version()} (headless=${cfg.twitter.headless})`;
    } finally {
      await browser.close().catch(() => {});
    }
  });

  await run("X reachable", async () => {
    const cfg = getConfig();
    const url = "https://x.com/search?q=bitcoin&f=live";
    const context = await createBrowser({
      cookies: ctx.cookies ?? undefined,
      proxy: parseProxy(ctx.account?.proxy_json ?? null),
      userAgent: ctx.account?.user_agent || undefined,
      timezone: ctx.account?.timezone || undefined,
    });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(cfg.twitter.requestTimeoutMs);
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: cfg.twitter.requestTimeoutMs,
      });
      const status = response?.status() ?? 0;
      const finalUrl = page.url();
      if (status === 403 || status === 429 || status === 503) {
        throw new Error(`X_BLOCKED: HTTP ${status} at ${finalUrl}`);
      }
      if (status >= 400) throw new Error(`X returned HTTP ${status} at ${finalUrl}`);
      const title = await page.title().catch(() => "");
      const body = await page.locator("body").innerText().catch(() => "");
      if (/just a moment|cloudflare ray id/i.test(`${title} ${body}`)) {
        throw new Error(`X_BLOCKED: Cloudflare challenge at ${finalUrl}`);
      }
      const auth = finalUrl.includes("/login") || finalUrl.includes("/i/flow/login");
      return `HTTP ${status}, url=${finalUrl}${auth ? " (redirect to login — сессия невалидна)" : ""}`;
    } finally {
      const browser = context.browser();
      if (browser) await browser.close().catch(() => {});
      else await context.close().catch(() => {});
    }
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`${TAG} summary: ${results.length - failed.length}/${results.length} checks OK`);
  if (failed.length > 0) {
    console.error(`${TAG} failing: ${failed.map((r) => r.name).join(", ")}`);
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(`${TAG} failed:`, e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => {}));
