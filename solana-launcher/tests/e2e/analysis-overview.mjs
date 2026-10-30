import assert from "node:assert/strict";
import { chromium } from "playwright";
const base = process.env.BASE_URL || "http://127.0.0.1:3000";
const a = "Bi6z17iWRMRejRHM56LHEdD5UQVsoexho5aeTR7kpump", b = "So11111111111111111111111111111111111111112";
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  page.setDefaultTimeout(60000);
  const errors = [], posts = [], reads = [];
  page.on("pageerror", error => errors.push(error.message));
  let mode = "populated", release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(url => url.pathname.startsWith("/api/") || url.pathname.startsWith("/fastapi/"), async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === "POST") { posts.push(url.pathname); return route.abort(); }
    const x = url.pathname === "/api/trade/dev-twitter", tg = url.pathname.includes("/api/v1/social/token/"), chain = url.pathname === "/api/blockchain/evidence";
    if (x || tg || chain) reads.push(url.pathname);
    const state = mode;
    if (x && state === "delayed" && url.searchParams.get("mint") === a) await gate;
    if (state === "error") return route.fulfill({ status: 503, json: { error: "source_unavailable" } });
    if (state === "malformed") return route.fulfill({ json: {} });
    const empty = state === "empty";
    let data;
    if (x) data = { symbol: "FIXTURE", totalTweets: empty ? 0 : url.searchParams.get("mint") === b ? 14 : 7, totalViews: 70, totalLikes: 3, totalRetweets: 2, uniqueMentioners: empty ? 0 : 1, botRiskScore: 12, anomalyCount: 0, topTweets: [], shillers: [], aggregated: { totalEngagement: 5, engagementRate: 5 / 70, verifiedAuthors: 0, botRatio: 0 } };
    else if (tg) data = { mentions: empty ? 0 : 12, platforms: { telegram: empty ? 0 : 12 }, origin: null, timeline: [], meta: { matchedPlatforms: { telegram: empty ? 0 : 12 }, uniqueSourcesBeforeLimit: empty ? 0 : 3, explicitTelegramCallsBeforeLimit: empty ? 0 : 2 } };
    else if (chain) data = { meta: { forensicIndexAvailable: empty, dexIndexAvailable: empty }, observedDexTrades: [], seedWalletTrades: [], walletPnl: [] };
    else if (url.pathname === "/api/token-ohlcv") data = { pair: { liquidityUsd: 1234, volumeH24: 2500, change24h: 12 } };
    else return route.fulfill({ status: 503, json: { error: "fixture_only" } });
    try { await route.fulfill({ json: data }); } catch { /* Superseded requests may have been aborted. */ }
  });
  await page.goto(`${base}/trade/analysis`, { waitUntil: "networkidle" });
  const value = id => page.locator(`[data-source="${id}"] .analysis-card-value`).textContent();
  const waitValue = (id, value) => page.waitForFunction(({ id, value }) => document.querySelector(`[data-source="${id}"] .analysis-card-value`)?.textContent === value, { id, value });
  const refresh = () => page.getByRole("button", { name: "Обновить сводку", exact: true }).click();
  assert.equal(reads.length, 0, "No source requests without a valid mint");
  assert.deepEqual(await page.locator(".analysis-card-value").allTextContents(), ["—", "—", "—", "—"]);
  async function select(mint) {
    const input = page.locator('[data-tag="trade.search_input"]'), submit = page.locator('[data-tag="trade.search_submit"]');
    // SSR can expose the form before React attaches handlers in a cold dev build.
    for (let attempt = 0; attempt < 100; attempt++) {
      await input.fill(""); await input.fill(mint);
      if (await submit.isEnabled()) break;
      await page.waitForTimeout(100);
    }
    await input.press("Escape"); await submit.click();
    await page.waitForURL(url => url.searchParams.get("mint") === mint);
  }
  await select(a); await waitValue("twitter", "7"); await waitValue("telegram", "12");
  assert.equal(await value("blockchain"), "—", "Missing indexes must not imply zero operations");
  assert.equal(await page.locator('[data-source="telegram"] dd').first().textContent(), "3", "Use the full filtered count, not retained sample size");
  assert.notEqual(await value("fomo"), "—");
  const mcap = page.getByText("MCap", { exact: true }); await mcap.waitFor();
  assert.equal(await mcap.locator("..").locator(".tabular-nums").textContent(), "—", "Missing market cap must not assume a token supply");
  assert.equal(await page.locator(".analysis-chart-content .text-2xl").textContent(), "—", "Missing price must not display $0");
  mode = "error"; await refresh(); await page.locator('[data-source="twitter"] .is-error').waitFor();
  assert.equal(await value("twitter"), "—"); assert.equal(await value("fomo"), "—");
  mode = "delayed";
  const pending = page.waitForRequest(request => request.url().includes("dev-twitter") && request.url().includes(a));
  await refresh(); await pending; await select(b); await waitValue("twitter", "14"); release(); await page.waitForTimeout(200);
  assert.equal(await value("twitter"), "14", "Late responses must not overwrite the current mint");
  mode = "empty"; await refresh(); await waitValue("twitter", "0"); await waitValue("telegram", "0"); await waitValue("blockchain", "0");
  assert.equal(await value("fomo"), "—", "Empty evidence cannot produce FOMO scores");
  mode = "malformed"; await refresh(); await page.locator('[data-source="twitter"] .is-error').waitFor(); assert.equal(await value("twitter"), "—");
  mode = "error";
  await page.getByRole("button", { name: /Открыть полный отчёт/ }).click();
  const dialog = page.getByRole("dialog"); await dialog.locator('[data-tag="trade.social.metrics"]').waitFor();
  const startAi = dialog.getByRole("button", { name: "Запустить AI", exact: true });
  await startAi.waitFor();
  const explicitAiRequest = page.waitForRequest(request =>
    request.method() === "POST" && new URL(request.url()).pathname === "/api/trade/blockchain-ai-report"
  );
  await startAi.click();
  await explicitAiRequest;
  // The request is deliberately aborted by the fixture; assert that only the explicit click initiated it.
  assert.deepEqual(posts, ["/api/trade/blockchain-ai-report"], "AI generation must happen only after explicit user action");
  assert.equal(await dialog.locator('[data-tag="trade.social.metrics"] .divide-y > div').count(), 141);
  assert(await dialog.evaluate(element => element.contains(document.elementFromPoint(120, 150))), "The report must appear above the desktop sidebar");
  for (const width of [390, 768, 1440]) { await page.setViewportSize({ width, height: 900 }); assert(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)); }
  await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" });
  for (const width of [320, 390, 768, 1440]) { await page.setViewportSize({ width, height: 900 }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Fit at ${width}px`); }
  assert.deepEqual(posts, ["/api/trade/blockchain-ai-report"], "No automatic AI generations; one explicit request is allowed"); assert.deepEqual(errors, []);
  console.log("ANALYSIS_OVERVIEW_OK: source values, missing/empty/error, stale mint, 141 fields, mobile; explicit AI request only");
} finally { await browser.close(); }
