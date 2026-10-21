import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3000";
const MINT = "Bi6z17iWRMRejRHM56LHEdD5UQVsoexho5aeTR7kpump";
const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  try {
    const page = await context.newPage();

    await page.goto(`${BASE_URL}/trade/analysis`, { waitUntil: "domcontentloaded" });
    let requestedMint = null;
    await page.route("**/api/trade/analyze-stream?*", async route => {
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
    await page.locator('[data-tag="trade.search_submit"]').click();
    await page.getByText("137", { exact: true }).waitFor({ state: "visible" });
    assert.equal(requestedMint, MINT, "Analysis must use the pasted mint");
    await page.waitForURL(url => url.searchParams.get("mint") === MINT);

    // A malformed mint must not be passed to the analysis API.
    await page.goto(`${BASE_URL}/trade/analysis`, { waitUntil: "domcontentloaded" });
    let invalidRequests = 0;
    await page.unrouteAll();
    await page.route("**/api/trade/analyze-stream?*", async route => {
      invalidRequests += 1;
      await route.abort();
    });
    await page.locator('[data-tag="trade.search_input"]').fill("invalid mint");
    await page.locator('[data-tag="trade.search_submit"]').click();
    await page.getByText(/Некорректный mint/).waitFor({ state: "visible" });
    assert.equal(invalidRequests, 0, "Invalid input must never initiate an analysis");
  } finally {
    await context.close();
  }
} finally {
  await browser.close();
}
