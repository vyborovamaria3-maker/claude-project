import { test, expect } from "@playwright/test";

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3000";
const TEST_MINT = "Bi6z17iWRMRejRHM56LHEdD5UQVsoexho5aeTR7kpump";

test.beforeEach(async ({ page }) => {
  await page.goto(`${BASE_URL}/trade/analysis`);
});

test("pasting a mint loads the analyzed values returned by the API", async ({ page }) => {
  let requestedMint: string | null = null;
  await page.route("**/api/trade/analyze-stream?*", async (route) => {
    requestedMint = new URL(route.request().url()).searchParams.get("mint");
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: JSON.stringify({
        type: "final",
        mint: TEST_MINT,
        summary: {
          totalVolumeSol: 5,
          totalVolumeUsd: 750,
          totalTrades: 7,
          uniqueWallets: 3,
        },
        wallets: [],
        dev: null,
        bundles: [],
        timeline: [],
        trades: [],
        fetchedAt: Date.now(),
      }) + "\n",
    });
  });

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate((mint) => navigator.clipboard.writeText(mint), TEST_MINT);
  await page.locator('[data-tag="trade.paste_btn"]').click();
  await expect(page.locator('[data-tag="trade.search_input"]')).toHaveValue(TEST_MINT);

  await page.locator('[data-tag="trade.search_submit"]').click();
  await expect(page.getByText("5.00 SOL")).toBeVisible();
  expect(requestedMint).toBe(TEST_MINT);
  await expect(page).toHaveURL(new RegExp(`[?&]mint=${TEST_MINT}`));
});

test("invalid mint cannot start an analysis request", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/trade/analyze-stream?*", async (route) => {
    requests += 1;
    await route.abort();
  });
  await page.locator('[data-tag="trade.search_input"]').fill("invalid mint");
  await page.locator('[data-tag="trade.search_submit"]').click();
  await expect(page.locator('[data-tag="trade.search_input"]')).toHaveValue("invalid mint");
  expect(requests).toBe(0);
});
