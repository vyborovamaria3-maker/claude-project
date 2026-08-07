import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium, devices } from "playwright";

const baseURL = process.env.BASE_URL || "http://127.0.0.1:3000";
const outputDir = path.resolve("test-results/mobile");
const WATCHDOG_MS = 180_000;

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

async function openRoute(page, route, pageErrors) {
  pageErrors.length = 0;
  console.log(`open ${route}`);

  const response = await page.goto(`${baseURL}${route}`, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });

  assert.ok(response, `${route}: no navigation response`);
  assert.ok(response.status() < 400, `${route}: returned HTTP ${response.status()}`);

  await page.waitForTimeout(700);
  await assertNoHorizontalOverflow(page, route);

  const name = route === "/" ? "dashboard" : route.replace(/^\//, "").replaceAll("/", "-");
  await page.screenshot({
    path: path.join(outputDir, `${name || "home"}.png`),
    fullPage: true,
    timeout: 15_000,
  });

  assert.equal(
    pageErrors.length,
    0,
    `${route}: browser page errors detected:\n${pageErrors.map((error) => `- ${error}`).join("\n")}`
  );

  console.log(`pass ${route}`);
}

async function run() {
  await fs.mkdir(outputDir, { recursive: true });

  const watchdog = setTimeout(() => {
    console.error(`mobile regression watchdog exceeded ${WATCHDOG_MS}ms`);
    process.exit(2);
  }, WATCHDOG_MS);
  watchdog.unref?.();

  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({
      ...devices["iPhone 13"],
      locale: "ru-RU",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(30_000);

    const pageErrors = [];

    page.on("pageerror", (error) => {
      const message = error?.stack || error?.message || String(error);
      pageErrors.push(message);
      console.error(`[pageerror] ${message}`);
    });

    for (const route of routes) {
      await openRoute(page, route, pageErrors);
    }

    console.log("check mobile navigation");
    pageErrors.length = 0;
    const homeResponse = await page.goto(`${baseURL}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    assert.ok(homeResponse && homeResponse.status() < 400, `/: returned HTTP ${homeResponse?.status() ?? "no response"}`);
    await page.waitForTimeout(400);

    const menuButton = page.getByRole("button", { name: "Open navigation" });
    await menuButton.waitFor({ state: "visible" });
    const menuBox = await menuButton.boundingBox();
    assert.ok(menuBox && menuBox.width >= 40 && menuBox.height >= 40, "mobile menu touch target is too small");
    await menuButton.click();

    const dialog = page.getByRole("dialog", { name: "Navigation" });
    await dialog.waitFor({ state: "visible" });

    const tradeDashboardLink = dialog.locator('a[href="/trade-dashboard"]').first();
    await tradeDashboardLink.click();
    await page.waitForURL(/\/trade-dashboard/);
    await assertNoHorizontalOverflow(page, "/trade-dashboard after mobile nav");
    assert.equal(pageErrors.length, 0, `mobile navigation produced browser errors:\n${pageErrors.join("\n")}`);
    console.log("pass mobile navigation");

    console.log("check period selector");
    pageErrors.length = 0;
    const launchResponse = await page.goto(`${baseURL}/launch-dashboard`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    assert.ok(launchResponse && launchResponse.status() < 400, `/launch-dashboard: returned HTTP ${launchResponse?.status() ?? "no response"}`);
    await page.waitForTimeout(400);
    const periodSelector = page.locator('[data-tag="dashboard.period_selector"]').first();
    await periodSelector.waitFor({ state: "visible" });

    const periodMetrics = await periodSelector.evaluate((node) => ({
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
      overflowX: getComputedStyle(node).overflowX,
    }));

    assert.ok(
      periodMetrics.scrollWidth <= periodMetrics.clientWidth + 2 || ["auto", "scroll"].includes(periodMetrics.overflowX),
      `period selector clips content without horizontal scrolling: ${JSON.stringify(periodMetrics)}`
    );
    assert.equal(pageErrors.length, 0, `/launch-dashboard produced browser errors:\n${pageErrors.join("\n")}`);
    console.log("pass period selector");

    console.log("check login form");
    pageErrors.length = 0;
    const loginResponse = await page.goto(`${baseURL}/login`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    assert.ok(loginResponse && loginResponse.status() < 400, `/login: returned HTTP ${loginResponse?.status() ?? "no response"}`);
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
    assert.equal(pageErrors.length, 0, `/login produced browser errors:\n${pageErrors.join("\n")}`);
    console.log("pass login form");

    console.log("mobile regression smoke passed");
  } finally {
    clearTimeout(watchdog);
    await browser.close().catch((error) => {
      console.error(`browser close failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
