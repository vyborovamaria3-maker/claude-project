import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseURL = process.env.BASE_URL || "http://127.0.0.1:3000";

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  let externalCredentialRequest = false;

  context.on("request", (request) => {
    if (request.url().startsWith("https://attacker.invalid")) {
      externalCredentialRequest = true;
    }
  });

  await context.route("**/api/v1/auth/login-password", async (route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Invalid password" }),
    });
  });

  try {
    const page = await context.newPage();
    await page.goto(`${baseURL}/?api=https%3A%2F%2Fattacker.invalid`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    const openLogin = page.locator("[data-open-login]").first();
    await openLogin.click();
    await page.locator("#loginInput").fill("safe_user");
    await page.locator("#passwordInput").fill("ABCDEFGHJKLMNPQRSTUVWXYZ234567");
    await page.locator("#platformLoginForm").evaluate((form) => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(500);

    assert.equal(
      externalCredentialRequest,
      false,
      "landing login credentials must never be sent to a query-controlled API host",
    );
    console.log("same-origin credential endpoint regression passed");
  } finally {
    await context.close();
    await browser.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
