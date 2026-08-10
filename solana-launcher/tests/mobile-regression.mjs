import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const baseURL = process.env.BASE_URL || "http://127.0.0.1:3000";
const outputDir = path.resolve("test-results/mobile");
const WATCHDOG_MS = 240_000;
const TEST_ACCESS_TOKEN = "local-responsive-backtest-token";

const routes = [
  "/auth",
  "/login",
  "/",
  "/launch-dashboard",
  "/trade-dashboard",
  "/trade/analysis",
  "/trade/analysis/social",
  "/market-overview",
];

const deviceProfiles = [
  { name: "phone-320", viewport: { width: 320, height: 568 }, routes: ["/", "/login", "/launch-dashboard", "/trade-dashboard"] },
  { name: "phone-390", viewport: { width: 390, height: 844 }, routes },
  { name: "phone-430", viewport: { width: 430, height: 932 }, routes: ["/", "/login", "/launch-dashboard", "/trade-dashboard"] },
  { name: "tablet-768", viewport: { width: 768, height: 1024 }, routes: ["/", "/login", "/launch-dashboard", "/trade-dashboard"] },
];

async function assertNoHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    html: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));

  const widest = Math.max(metrics.html, metrics.body);
  assert.ok(
    widest <= metrics.viewport + 2,
    `${label}: horizontal overflow detected (${widest}px content vs ${metrics.viewport}px viewport)`
  );
}

async function assertBasicAccessibility(page, label) {
  const result = await page.evaluate(() => {
    const lang = document.documentElement.getAttribute("lang")?.trim() || "";
    const viewportMeta = document.querySelector('meta[name="viewport"]')?.getAttribute("content") || "";
    const visible = (element) => {
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
    };
    const accessibleName = (element) => [
      element.textContent,
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("alt"),
    ].filter(Boolean).join(" ").trim();

    const unnamedButtons = [...document.querySelectorAll("button")]
      .filter((button) => visible(button) && !accessibleName(button))
      .length;
    const unnamedLinks = [...document.querySelectorAll("a[href]")]
      .filter((link) => visible(link) && !accessibleName(link))
      .length;
    const imagesMissingAlt = [...document.querySelectorAll("img")]
      .filter((image) => !image.hasAttribute("alt"))
      .length;
    const positiveTabIndex = [...document.querySelectorAll("[tabindex]")]
      .filter((element) => Number(element.getAttribute("tabindex")) > 0)
      .length;
    const unlabeledDialogs = [...document.querySelectorAll('[role="dialog"], dialog')]
      .filter((dialog) => visible(dialog) && !dialog.getAttribute("aria-label") && !dialog.getAttribute("aria-labelledby"))
      .length;

    return {
      lang,
      viewportMeta,
      unnamedButtons,
      unnamedLinks,
      imagesMissingAlt,
      positiveTabIndex,
      unlabeledDialogs,
    };
  });

  assert.ok(result.lang, `${label}: <html> must have a lang attribute`);
  assert.match(result.viewportMeta, /width\s*=\s*device-width/i, `${label}: viewport meta must use device-width`);
  assert.equal(result.unnamedButtons, 0, `${label}: visible buttons without an accessible name detected`);
  assert.equal(result.unnamedLinks, 0, `${label}: visible links without an accessible name detected`);
  assert.equal(result.imagesMissingAlt, 0, `${label}: images without alt attributes detected`);
  assert.equal(result.positiveTabIndex, 0, `${label}: positive tabindex values break natural keyboard order`);
  assert.equal(result.unlabeledDialogs, 0, `${label}: visible dialogs must have an accessible label`);
}

async function openRoute(page, route, profileName, pageErrors) {
  pageErrors.length = 0;
  const label = `${profileName} ${route}`;
  console.log(`open ${label}`);

  const response = await page.goto(`${baseURL}${route}`, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });

  assert.ok(response, `${label}: no navigation response`);
  assert.ok(response.status() < 400, `${label}: returned HTTP ${response.status()}`);

  await page.waitForTimeout(500);
  await assertNoHorizontalOverflow(page, label);
  await assertBasicAccessibility(page, label);

  const routeName = route === "/" ? "dashboard" : route.replace(/^\//, "").replaceAll("/", "-");
  await page.screenshot({
    path: path.join(outputDir, `${profileName}-${routeName || "home"}.png`),
    fullPage: true,
    timeout: 15_000,
  });

  assert.equal(
    pageErrors.length,
    0,
    `${label}: browser page errors detected:\n${pageErrors.map((error) => `- ${error}`).join("\n")}`
  );

  console.log(`pass ${label}`);
}

async function assertMobileNavigationKeyboardFlow(page, profileName, pageErrors) {
  pageErrors.length = 0;
  await page.goto(`${baseURL}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(300);

  const menuButton = page.getByRole("button", { name: "Open navigation" });
  await menuButton.waitFor({ state: "visible" });
  const menuBox = await menuButton.boundingBox();
  assert.ok(menuBox && menuBox.width >= 40 && menuBox.height >= 40, `${profileName}: mobile menu touch target is too small`);

  await menuButton.focus();
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog", { name: "Navigation" });
  await dialog.waitFor({ state: "visible" });
  const focusedInsideDialog = await page.evaluate(() => {
    const active = document.activeElement;
    const dialogElement = document.querySelector('[role="dialog"][aria-label="Navigation"]');
    return Boolean(active && dialogElement?.contains(active));
  });
  assert.ok(focusedInsideDialog, `${profileName}: focus must move into mobile navigation dialog`);

  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await assertNoHorizontalOverflow(page, `${profileName} after Escape closes nav`);
  assert.equal(pageErrors.length, 0, `${profileName}: keyboard navigation produced browser errors`);

  await menuButton.focus();
  await page.keyboard.press("Enter");
  await dialog.waitFor({ state: "visible" });
  const tradeDashboardLink = dialog.locator('a[href="/trade-dashboard"]').first();
  await tradeDashboardLink.click();
  await page.waitForURL(/\/trade-dashboard/);
  await assertNoHorizontalOverflow(page, `${profileName} trade-dashboard after nav`);
  assert.equal(pageErrors.length, 0, `${profileName}: mobile navigation produced browser errors`);
}

async function installAuthenticatedBacktestSession(context) {
  await context.addInitScript((token) => {
    window.localStorage.setItem("potapoff.access_token", token);
  }, TEST_ACCESS_TOKEN);

  await context.route("**/api/v1/auth/me", async (route) => {
    const authorization = route.request().headers().authorization || "";
    if (authorization !== `Bearer ${TEST_ACCESS_TOKEN}`) {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Unauthorized" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "00000000-0000-0000-0000-000000000001",
        email: null,
        access_login: "backtest_user",
        is_active: true,
        is_superuser: false,
      }),
    });
  });
}

async function assertPrivateRouteRequiresAccess(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    await page.goto(`${baseURL}/launch-dashboard`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForURL(/\/login(?:$|[?#])/, { timeout: 10_000 });
    assert.equal(new URL(page.url()).pathname, "/login");
    console.log("pass private-route subscription gate");
  } finally {
    await context.close();
  }
}

async function runProfile(browser, profile) {
  const context = await browser.newContext({
    viewport: profile.viewport,
    screen: profile.viewport,
    isMobile: profile.viewport.width < 768,
    hasTouch: true,
    deviceScaleFactor: 2,
    locale: "ru-RU",
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  await installAuthenticatedBacktestSession(context);

  try {
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(30_000);

    const pageErrors = [];
    page.on("pageerror", (error) => {
      const message = error?.stack || error?.message || String(error);
      pageErrors.push(message);
      console.error(`[pageerror] ${profile.name}: ${message}`);
    });

    for (const route of profile.routes) {
      await openRoute(page, route, profile.name, pageErrors);
    }

    await assertMobileNavigationKeyboardFlow(page, profile.name, pageErrors);

    pageErrors.length = 0;
    await page.goto(`${baseURL}/launch-dashboard`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(300);
    const periodSelector = page.locator('[data-tag="dashboard.period_selector"]').first();
    await periodSelector.waitFor({ state: "visible" });
    const periodMetrics = await periodSelector.evaluate((node) => ({
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
      overflowX: getComputedStyle(node).overflowX,
    }));
    assert.ok(
      periodMetrics.scrollWidth <= periodMetrics.clientWidth + 2 || ["auto", "scroll"].includes(periodMetrics.overflowX),
      `${profile.name}: period selector clips without horizontal scrolling: ${JSON.stringify(periodMetrics)}`
    );
    assert.equal(pageErrors.length, 0, `${profile.name}: launch dashboard produced browser errors`);

    pageErrors.length = 0;
    await page.goto(`${baseURL}/login`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const inputs = page.locator("input");
    assert.ok((await inputs.count()) >= 2, `${profile.name}: login page should expose login and password fields`);
    await inputs.nth(0).fill("mobile_user");
    await inputs.nth(1).fill("12345678901234567890123456789012");
    await assertNoHorizontalOverflow(page, `${profile.name} login after fill`);

    if (profile.viewport.width <= 640) {
      const fontSizes = await inputs.evaluateAll((nodes) => nodes.slice(0, 2).map((node) => Number.parseFloat(getComputedStyle(node).fontSize)));
      assert.ok(fontSizes.every((size) => size >= 16), `${profile.name}: mobile inputs must use >=16px font to prevent iOS auto-zoom`);
    }
    assert.equal(pageErrors.length, 0, `${profile.name}: login interaction produced browser errors`);
  } finally {
    await context.close();
  }
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
    await assertPrivateRouteRequiresAccess(browser);
    for (const profile of deviceProfiles) {
      console.log(`\n=== ${profile.name} ${profile.viewport.width}x${profile.viewport.height} ===`);
      await runProfile(browser, profile);
    }
    console.log("cross-device mobile regression passed");
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
