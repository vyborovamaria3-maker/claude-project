import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseURL = process.env.BASE_URL || "http://127.0.0.1:3000";

async function run() {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));

      const response = await page.goto(`${baseURL}/launch-dashboard`, {
        waitUntil: "domcontentloaded",
      });
      assert(response && response.status() < 500, "Dashboard failed to load");
      // DOM content may arrive before Next.js attaches client-side click handlers.
      await page.waitForLoadState("load");

      const menu = page.getByRole("button", { name: "Open navigation" });
      await menu.waitFor({ state: "visible" });
      await menu.click();
      const dialog = page.getByRole("dialog", { name: "Navigation" });
      await dialog.waitFor({ state: "visible" });

      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });

      await menu.focus();
      await page.keyboard.press("Enter");
      await dialog.waitFor({ state: "visible" });
      await dialog.locator('a[href="/trade-dashboard"]').click();
      await page.waitForURL(/\/trade-dashboard(?:[?#]|$)/);

      assert.deepEqual(errors, [], "Mobile navigation must not crash");
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
