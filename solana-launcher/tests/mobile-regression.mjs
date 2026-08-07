import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium, devices } from "playwright";

const baseURL = process.env.BASE_URL || "http://127.0.0.1:3000";
const outputDir = path.resolve("test-results/mobile");

const routes = [
  "/auth",
  "/login",
  "/",
  "/launch-dashboard",
  "/trade-dashboard",
  "/trade/analysis",
  "/market-overview",
];

async function assertNoHorizontalOverflow(page, route) {
  const metrics = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    html: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));

  const widest = Math.max(metrics.html, metrics.body);
  assert.ok(
    widest <= metrics.viewport + 2,
    `${route}: horizontal overflow detected (${widest}px content vs ${metrics.viewport}px viewport)`
  );
}

async function openRoute(page, route) {
  const response = await page.goto(`${baseURL}${route}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  assert.ok(response, `${route}: no navigation response`);
  assert.ok(response.status() < 500, `${route}: returned HTTP ${response.status()}`);

  await page.waitForTimeout(900);
  await assertNoHorizontalOverflow(page, route);

  const name = route === "/" ? "dashboard" : route.replace(/^\//, "").replaceAll("/", "-");
  await page.screenshot({
    path: path.join(outputDir, `${name || "home"}.png`),
    fullPage: true,
  });
}

async function run() {
  await fs.mkdir(outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ...devices["iPhone 13"],
    locale: "ru-RU",
  });
  const page = await context.newPage();

  page.on("pageerror", (error) => {
    console.error(`[pageerror] ${error.message}`);
  });

  for (const route of routes) {
    console.log(`mobile smoke: ${route}`);
    await openRoute(page, route);
  }

  await page.goto(`${baseURL}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(500);

  const menuButton = page.getByRole("button", { name: "Open navigation" });
  await menuButton.waitFor({ state: "visible", timeout: 10_000 });
  const menuBox = await menuButton.boundingBox();
  assert.ok(menuBox && menuBox.width >= 40 && menuBox.height >= 40, "mobile menu touch target is too small");
  await menuButton.click();

  const dialog = page.getByRole("dialog", { name: "Navigation" });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });

  const tradeDashboardLink = dialog.locator('a[href="/trade-dashboard"]').first();
  await tradeDashboardLink.click();
  await page.waitForURL(/\/trade-dashboard/, { timeout: 15_000 });
  await assertNoHorizontalOverflow(page, "/trade-dashboard after mobile nav");

  await page.goto(`${baseURL}/launch-dashboard`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(500);
  const periodSelector = page.locator('[data-tag="dashboard.period_selector"]').first();
  await periodSelector.waitFor({ state: "visible", timeout: 10_000 });

  const periodMetrics = await periodSelector.evaluate((node) => ({
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
    overflowX: getComputedStyle(node).overflowX,
  }));

  assert.ok(
    periodMetrics.scrollWidth <= periodMetrics.clientWidth + 2 || ["auto", "scroll"].includes(periodMetrics.overflowX),
    `period selector clips content without horizontal scrolling: ${JSON.stringify(periodMetrics)}`
  );

  await page.goto(`${baseURL}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const inputs = page.locator("input");
  assert.ok((await inputs.count()) >= 2, "login page should expose login and password fields");
  await inputs.nth(0).fill("mobile_user");
  await inputs.nth(1).fill("12345678901234567890123456789012");
  await assertNoHorizontalOverflow(page, "/login after filling form");

  const viewportWidth = await page.evaluate(() => document.documentElement.clientWidth);
  for (let index = 0; index < Math.min(2, await inputs.count()); index += 1) {
    const box = await inputs.nth(index).boundingBox();
    assert.ok(box && box.width <= viewportWidth + 1, `login input ${index} exceeds viewport`);
  }

  await browser.close();
  console.log("mobile regression smoke passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
