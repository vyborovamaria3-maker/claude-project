import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseURL = process.env.BASE_URL || "http://127.0.0.1:3000";
const profiles = [
  { name: "phone-320", viewport: { width: 320, height: 568 } },
  { name: "phone-390", viewport: { width: 390, height: 844 } },
  { name: "phone-430", viewport: { width: 430, height: 932 } },
  { name: "tablet-768", viewport: { width: 768, height: 1024 } },
];

async function checkNavigation(browser, { name, viewport }) {
  const context = await browser.newContext({
    viewport,
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));

    const response = await page.goto(baseURL + "/launch-dashboard", {
      waitUntil: "domcontentloaded",
    });
    assert(response && response.status() < 400,
      name + ": dashboard returned HTTP " + (response?.status() ?? "no response"));
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

    const target = await page.request.get(baseURL + "/trade-dashboard");
    assert(target.status() < 400,
      name + ": navigation target returned HTTP " + target.status());
    assert.deepEqual(errors, [], name + ": mobile navigation must not crash");
  } finally {
    await context.close();
  }
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const profile of profiles) {
      await checkNavigation(browser, profile);
    }
  } finally {
    await browser.close();
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
