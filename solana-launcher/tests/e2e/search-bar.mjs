import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3000";
const MINT = "Bi6z17iWRMRejRHM56LHEdD5UQVsoexho5aeTR7kpump";
const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
    serviceWorkers: "block",
  });
  try {
    const page = await context.newPage();

    await page.goto(`${BASE_URL}/trade/analysis`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load");
    let requestedMint = null;
    await page.route(url => url.pathname === "/api/trade/analyze-stream", async route => {
      requestedMint = new URL(route.request().url()).searchParams.get("mint");
      await route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body: JSON.stringify({
          type: "final",
          mint: MINT,
          summary: { totalVolumeSol: 5, totalVolumeUsd: 750,
                     totalTrades: 137, uniqueWallets: 3 },
          wallets: [],
          dev: null,
          bundles: [],
          timeline: [],
          trades: [],
          fetchedAt: Date.now(),
        }) + "\n",
      });
    });

    await page.evaluate(mint => navigator.clipboard.writeText(mint), MINT);
    await page.locator('[data-tag="trade.paste_btn"]').click();
    await page.waitForFunction(
      expected => document.querySelector('[data-tag="trade.search_input"]')?.value === expected,
      MINT,
    );
    const analysisResponsePromise = page.waitForResponse(response =>
      response.url().includes("/api/trade/analyze-stream?") &&
      response.request().method() === "GET"
    );
    await page.locator('[data-tag="trade.search_submit"]').click();
    const analysisResponse = await analysisResponsePromise;
    assert.equal(analysisResponse.status(), 200, "Analysis request must succeed");
    assert.equal(requestedMint, MINT, "Analysis must use the pasted mint");
    await page.waitForURL(url => url.searchParams.get("mint") === MINT);
    await page.getByRole("button", { name: /Trades\s+137\b/ })
      .waitFor({ state: "visible" });

    // Test invalid input on a fresh tab to avoid state persisted by the
    // successful analysis and in-flight navigation from the previous scenario.
    const invalidPage = await context.newPage();
    try {
      let invalidRequests = 0;
      await invalidPage.route(url => url.pathname === "/api/trade/analyze-stream", async route => {
        invalidRequests += 1;
        await route.abort();
      });
      await invalidPage.goto(`${BASE_URL}/trade/analysis`, { waitUntil: "domcontentloaded" });
      await invalidPage.waitForLoadState("load");
      const input = invalidPage.locator('[data-tag="trade.search_input"]');
      const submit = invalidPage.locator('[data-tag="trade.search_submit"]');
      // A freshly loaded Next.js page can show server-rendered form controls
      // before React hydration. Retry the real input interaction until its
      // observable enabled state confirms that the change handler is attached.
      for (let attempt = 0; attempt < 20 && !(await submit.isEnabled()); attempt++) {
        await input.fill("");
        await input.fill("invalid mint");
        if (!(await submit.isEnabled())) await invalidPage.waitForTimeout(100);
      }
      assert(await submit.isEnabled(), "SearchBar did not become interactive");
      await submit.click();
      await invalidPage.getByText(/Некорректный mint/).waitFor({ state: "visible" });
      assert.equal(invalidRequests, 0, "Invalid input must never initiate an analysis");
      assert.equal(new URL(invalidPage.url()).searchParams.get("mint"), null,
        "Invalid input must not navigate to analysis results");
    } finally {
      await invalidPage.close();
    }
  } finally {
    await context.close();
  }
} finally {
  await browser.close();
}
