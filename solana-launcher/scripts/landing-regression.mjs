import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.LANDING_TEST_PORT || 3017);
const EXTERNAL_BASE_URL = process.env.LANDING_TEST_URL?.replace(/\/$/, "") || "";
const BASE_URL = EXTERNAL_BASE_URL || `http://127.0.0.1:${PORT}`;
const SERVER_TIMEOUT_MS = 90_000;
const MIN_MARKET_SPAN_MS = 23 * 60 * 60 * 1000;
const MAX_MARKET_AGE_MS = 6 * 60 * 60 * 1000;

const viewports = [
  { name: "phone-320", width: 320, height: 568 },
  { name: "phone-375", width: 375, height: 667 },
  { name: "iphone-390", width: 390, height: 844 },
  { name: "phone-430", width: 430, height: 932 },
  { name: "iphone-landscape", width: 844, height: 390 },
  { name: "tablet-768", width: 768, height: 1024 },
  { name: "tablet-landscape", width: 1024, height: 768 },
  { name: "desktop", width: 1440, height: 900 },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(url) {
  const deadline = Date.now() + SERVER_TIMEOUT_MS;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status >= 200 && response.status < 400) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(750);
  }

  throw new Error(`Landing server did not become ready: ${lastError?.message || url}`);
}

function startLocalServer() {
  if (EXTERNAL_BASE_URL) return null;

  const child = spawn(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", String(PORT)],
    {
      cwd: PROJECT_DIR,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  child.stdout.on("data", (chunk) => process.stdout.write(`[next] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[next] ${chunk}`));
  return child;
}

function killServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 2_000).unref();
}

async function assertNoHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    viewport: window.innerWidth,
    html: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    main: document.querySelector("main")?.scrollWidth || 0,
  }));

  const maxWidth = Math.max(metrics.html, metrics.body, metrics.main);
  assert.ok(
    maxWidth <= metrics.viewport + 1,
    `${label}: horizontal overflow ${maxWidth}px > ${metrics.viewport}px`,
  );
}

async function assertCriticalBoxesInsideViewport(page, label) {
  const result = await page.evaluate(() => {
    const selectors = ["header", "main h1", "#market", "#features", "#workspace", "footer"];

    return selectors.map((selector) => {
      const element = document.querySelector(selector);
      if (!element) return { selector, missing: true };
      const rect = element.getBoundingClientRect();
      return {
        selector,
        missing: false,
        left: rect.left,
        right: rect.right,
        width: rect.width,
        viewport: window.innerWidth,
      };
    });
  });

  for (const item of result) {
    assert.equal(item.missing, false, `${label}: missing ${item.selector}`);
    assert.ok(item.width > 0, `${label}: ${item.selector} has zero width`);
    assert.ok(item.left >= -2, `${label}: ${item.selector} escapes left edge (${item.left})`);
    assert.ok(
      item.right <= item.viewport + 2,
      `${label}: ${item.selector} escapes right edge (${item.right} > ${item.viewport})`,
    );
  }
}

async function assertAnchorsResolve(page, label) {
  const broken = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href^="#"]'))
      .map((anchor) => anchor.getAttribute("href"))
      .filter((href) => href && href !== "#")
      .filter((href, index, values) => values.indexOf(href) === index)
      .filter((href) => !document.querySelector(href)),
  );

  assert.deepEqual(broken, [], `${label}: broken local anchors: ${broken.join(", ")}`);
}

async function assertViewportMetadata(page, label) {
  const content = await page.locator('meta[name="viewport"]').getAttribute("content");
  assert.ok(content, `${label}: viewport meta is missing`);
  assert.match(content, /width=device-width/iu, `${label}: viewport width=device-width missing`);
  assert.match(content, /viewport-fit=cover/iu, `${label}: viewport-fit=cover missing`);
  assert.match(content, /user-scalable=yes|maximum-scale=5/iu, `${label}: zoom must remain available`);
}

async function assertThemePersistence(page) {
  const toggle = page.getByRole("button", { name: /переключить тему/i });
  await toggle.click();
  await page.waitForFunction(() => document.querySelector("main")?.getAttribute("data-theme") === "solana");
  assert.equal(await page.evaluate(() => localStorage.getItem("potapoff.landing_theme")), "solana");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("main")?.getAttribute("data-theme") === "solana");

  await page.evaluate(() => localStorage.removeItem("potapoff.landing_theme"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("main")?.getAttribute("data-theme") === "gold");
}

async function assertLoginDialog(page, label) {
  const openButtons = page.getByRole("button", { name: /открыть платформу/i });
  assert.ok((await openButtons.count()) > 0, `${label}: no platform CTA`);

  const trigger = openButtons.first();
  await trigger.focus();
  const triggerHandle = await trigger.elementHandle();
  assert.ok(triggerHandle, `${label}: CTA handle unavailable`);
  await trigger.click();

  const dialog = page.getByRole("dialog", { name: /войти в potapoff/i });
  await dialog.waitFor({ state: "visible" });

  const inputs = dialog.locator("input");
  const inputMetrics = await inputs.evaluateAll((nodes) =>
    nodes.map((input) => input.getBoundingClientRect().height),
  );
  assert.equal(inputMetrics.length, 2, `${label}: expected two login inputs`);
  assert.ok(inputMetrics.every((height) => height >= 44), `${label}: login touch target below 44px`);
  await page.waitForFunction(() => document.activeElement?.getAttribute("name") === "username");

  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page.waitForFunction((button) => document.activeElement === button, triggerHandle);
  await triggerHandle.dispose();
}

async function assertTouchLoginBackdrop(page, label) {
  const trigger = page.getByRole("button", { name: /открыть платформу/i }).first();
  await trigger.click();

  const dialog = page.getByRole("dialog", { name: /войти в potapoff/i });
  const backdrop = page.locator("[data-landing-login-backdrop]");
  await dialog.waitFor({ state: "visible" });
  await backdrop.waitFor({ state: "visible" });

  const backdropBox = await backdrop.boundingBox();
  assert.ok(backdropBox && backdropBox.width > 8 && backdropBox.height > 8, `${label}: login backdrop has no touchable area`);
  await page.touchscreen.tap(backdropBox.x + 4, backdropBox.y + 4);
  await dialog.waitFor({ state: "hidden" });

  await trigger.click();
  await dialog.waitFor({ state: "visible" });
  const submit = dialog.getByRole("button", { name: /войти в платформу/i });
  assert.equal(await submit.isDisabled(), false, `${label}: submit stayed disabled after backdrop close/reopen`);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
}

async function assertAuthSameOrigin(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  let interceptedUrl = "";
  const foreignRequests = [];

  await context.route("**/api/v1/auth/login-password", async (route) => {
    interceptedUrl = route.request().url();
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Invalid password" }),
    });
  });

  const page = await context.newPage();
  page.on("request", (request) => {
    if (new URL(request.url()).origin === "https://example.invalid") {
      foreignRequests.push(request.url());
    }
  });

  const maliciousApi = encodeURIComponent("https://example.invalid");
  await page.goto(`${BASE_URL}/?api=${maliciousApi}`, { waitUntil: "domcontentloaded" });

  const landedUrl = new URL(page.url());
  assert.equal(landedUrl.origin, new URL(BASE_URL).origin, "malicious api query escaped the landing origin");
  assert.equal(landedUrl.searchParams.has("api"), false, "proxy must strip the malicious api query parameter");
  assert.deepEqual(foreignRequests, [], `browser contacted foreign auth origin: ${foreignRequests.join(", ")}`);

  await page.getByRole("button", { name: /открыть платформу/i }).first().click();

  const dialog = page.getByRole("dialog", { name: /войти в potapoff/i });
  await dialog.getByRole("textbox", { name: /логин/i }).fill("tester_1");
  await dialog.getByLabel(/пароль/i).fill("A".repeat(32));
  await dialog.getByRole("button", { name: /войти в платформу/i }).click();
  await dialog.getByText(/неверный логин или пароль/i).waitFor({ state: "visible" });

  assert.ok(interceptedUrl, "auth request was not observed");
  assert.equal(
    new URL(interceptedUrl).origin,
    new URL(BASE_URL).origin,
    `credentials escaped same origin: ${interceptedUrl}`,
  );
  assert.deepEqual(foreignRequests, [], `credentials triggered foreign requests: ${foreignRequests.join(", ")}`);

  await context.close();
}

async function assertClientFreshnessGuard(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const now = Date.now();
  const updatedAt = now - 11 * 60 * 1000;
  const points = Array.from({ length: 24 }, (_, index) => ({
    time: updatedAt - (23 - index) * 60 * 60 * 1000,
    price: 100 + index * 0.1,
  }));
  const prices = points.map((point) => point.price);
  const first = points[0];
  const last = points.at(-1);
  const payload = {
    price: last.price,
    change24h: ((last.price - first.price) / first.price) * 100,
    high24h: Math.max(...prices),
    low24h: Math.min(...prices),
    volume24h: 1_000_000,
    marketCap: 50_000_000_000,
    updatedAt,
    servedAt: now,
    windowStart: first.time,
    windowEnd: updatedAt,
    sourcePointCount: points.length,
    plottedPointCount: points.length,
    stale: false,
    staleReason: null,
    points,
    source: "CoinGecko",
    quote: "USD",
  };

  await context.route("**/api/market/solana", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Cache-Control": "no-store" },
      body: JSON.stringify(payload),
    });
  });

  const page = await context.newPage();
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  const status = page.locator("[data-landing-market-status]");
  await page.waitForFunction(() =>
    document.querySelector("[data-landing-market-status]")?.textContent?.includes("ЗАДЕРЖКА"),
  );
  const statusText = (await status.textContent()) || "";
  assert.match(statusText, /ЗАДЕРЖКА/u, "client must downgrade an over-10m payload even when stale=false");
  assert.doesNotMatch(statusText, /LIVE/u, "client showed LIVE for an over-10m payload");

  await context.close();
}

async function assertMobileMenu(page, viewport) {
  if (viewport.width > 980) return;

  const menuButton = page.getByRole("button", { name: /открыть меню/i });
  const themeToggle = page.locator("[data-landing-theme-toggle]");
  await menuButton.waitFor({ state: "visible" });
  await themeToggle.waitFor({ state: "visible" });

  const menuButtonBox = await menuButton.boundingBox();
  const themeToggleBox = await themeToggle.boundingBox();
  assert.ok(menuButtonBox && menuButtonBox.width >= 44 && menuButtonBox.height >= 44, `${viewport.name}: menu toggle below 44x44`);
  assert.ok(themeToggleBox && themeToggleBox.width >= 44 && themeToggleBox.height >= 44, `${viewport.name}: theme toggle below 44x44`);

  await menuButton.click();
  const mobileMenu = page.locator("#landing-mobile-menu");
  await mobileMenu.waitFor({ state: "visible" });
  assert.equal(await menuButton.getAttribute("aria-expanded"), "true", `${viewport.name}: menu aria state did not open`);
  assert.equal(await mobileMenu.locator('a[href="#market"]').count(), 1, `${viewport.name}: market link missing`);

  const menuMetrics = await mobileMenu.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      maxHeight: style.maxHeight,
      overflowY: style.overflowY,
      linkHeights: Array.from(element.querySelectorAll("a")).map((anchor) => anchor.getBoundingClientRect().height),
    };
  });
  assert.notEqual(menuMetrics.maxHeight, "none", `${viewport.name}: mobile menu has no viewport max-height`);
  assert.equal(menuMetrics.overflowY, "auto", `${viewport.name}: mobile menu must scroll vertically when needed`);
  assert.ok(menuMetrics.linkHeights.length > 0, `${viewport.name}: no mobile menu links found`);
  assert.ok(menuMetrics.linkHeights.every((height) => height >= 44), `${viewport.name}: mobile menu link below 44px`);

  await page.keyboard.press("Escape");
  await mobileMenu.waitFor({ state: "hidden" });
  assert.equal(await menuButton.getAttribute("aria-expanded"), "false", `${viewport.name}: menu aria state did not close`);
}

async function assertMarketPayload(context) {
  const response = await context.request.get(`${BASE_URL}/api/market/solana`, { timeout: 15_000 });
  const body = await response.text();

  assert.equal(
    response.status(),
    200,
    `market API must be healthy for regression; got ${response.status()}: ${body.slice(0, 240)}`,
  );

  const data = JSON.parse(body);
  assert.equal(data.source, "CoinGecko");
  assert.equal(data.quote, "USD");
  assert.ok(Number.isFinite(data.price) && data.price > 0, "market price must be positive");
  assert.ok(Array.isArray(data.points) && data.points.length >= 24, "market graph needs enough real points");
  assert.ok(data.points.length <= 120, "market graph exceeded point budget");
  assert.equal(data.plottedPointCount, data.points.length, "plottedPointCount mismatch");
  assert.ok(data.sourcePointCount >= data.plottedPointCount, "sourcePointCount smaller than plottedPointCount");

  for (let index = 0; index < data.points.length; index += 1) {
    const point = data.points[index];
    assert.ok(Number.isFinite(point.time) && point.time > 0, `invalid timestamp at ${index}`);
    assert.ok(Number.isFinite(point.price) && point.price > 0, `invalid price at ${index}`);
    if (index > 0) {
      assert.ok(point.time > data.points[index - 1].time, "market points must be strictly ordered");
    }
  }

  const first = data.points[0];
  const last = data.points.at(-1);
  const span = last.time - first.time;
  assert.ok(span >= MIN_MARKET_SPAN_MS, `market window too short: ${span}`);
  assert.equal(data.windowStart, first.time, "windowStart must match first plotted/source endpoint");
  assert.equal(data.windowEnd, last.time, "windowEnd must match last plotted/source endpoint");
  assert.equal(data.updatedAt, data.windowEnd, "updatedAt must match source window end");
  assert.equal(data.price, last.price, "headline price must match latest plotted point");
  assert.ok(
    Date.now() - data.updatedAt <= MAX_MARKET_AGE_MS,
    `market payload is older than six hours: ${Date.now() - data.updatedAt}ms`,
  );

  const plottedPrices = data.points.map((point) => point.price);
  const plottedHigh = Math.max(...plottedPrices);
  const plottedLow = Math.min(...plottedPrices);
  assert.ok(Math.abs(plottedHigh - data.high24h) < 1e-6, "downsample lost real 24h high");
  assert.ok(Math.abs(plottedLow - data.low24h) < 1e-6, "downsample lost real 24h low");

  const plottedChange = ((last.price - first.price) / first.price) * 100;
  assert.ok(Math.abs(plottedChange - data.change24h) < 1e-6, "24h change does not match plotted endpoints");

  if (data.stale) {
    assert.ok(
      data.staleReason === "delayed_source" || data.staleReason === "upstream_error",
      "stale payload must explain staleReason",
    );
  } else {
    assert.equal(data.staleReason, null, "LIVE payload must not carry staleReason");
    assert.ok(Date.now() - data.updatedAt <= 10 * 60 * 1000, "LIVE payload is older than 10 minutes");
  }

  const headers = response.headers();
  assert.equal(headers["x-potapoff-market-source"], "CoinGecko");
  assert.equal(headers["x-potapoff-market-stale"], data.stale ? "1" : "0");
  assert.match(headers["cache-control"] || "", /\bno-store\b/iu, "market response must not be shared-cacheable");
}

async function waitForChart(page) {
  const line = page.locator("[data-landing-chart-line]");
  await line.waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForFunction(() => {
    const path = document.querySelector("[data-landing-chart-line]");
    return Boolean(path?.getAttribute("d")?.startsWith("M"));
  });
}

async function assertChartInteraction(page, useTouch = false) {
  await waitForChart(page);
  const chart = page.locator("[data-landing-chart]");
  await chart.waitFor({ state: "visible" });

  const gridIsValid = await page.evaluate(() => {
    const grid = document.querySelector("[data-landing-chart-grid]");
    if (!grid) return false;
    const lines = Array.from(grid.querySelectorAll("line"));
    const vertical = lines.slice(5, 9);
    return vertical.length === 4 && vertical.every((line) => line.getAttribute("x1") === line.getAttribute("x2"));
  });
  assert.equal(gridIsValid, true, "SOL chart vertical grid geometry is broken");

  const box = await chart.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, "chart has no interactive bounds");

  const x = box.x + box.width * 0.58;
  const y = box.y + box.height * 0.45;
  if (useTouch) await page.touchscreen.tap(x, y);
  else await page.mouse.move(x, y);

  const tooltip = page.locator("[data-landing-chart-tooltip]");
  await tooltip.waitFor({ state: "visible", timeout: 5_000 });
  const text = (await tooltip.textContent()) || "";
  assert.match(text, /\$/u, "chart tooltip should contain USD price");
  assert.match(text, /\d{1,2}:\d{2}/u, "chart tooltip should contain market point time");

  if (!useTouch) {
    await chart.focus();
    const focusOutline = await chart.evaluate((element) => getComputedStyle(element).outlineStyle);
    assert.notEqual(focusOutline, "none", "keyboard chart focus must remain visible");
    await page.keyboard.press("ArrowLeft");
    await tooltip.waitFor({ state: "visible" });
    const keyboardText = (await tooltip.textContent()) || "";
    assert.match(keyboardText, /\$/u, "keyboard chart inspection lost price tooltip");
  }
}

async function runViewport(browser, viewport) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    reducedMotion: "no-preference",
    hasTouch: viewport.width <= 980,
  });
  const page = await context.newPage();
  const browserErrors = [];

  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  });

  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.getByRole("heading", { level: 1 }).waitFor({ state: "visible" });

  await assertViewportMetadata(page, viewport.name);
  await assertNoHorizontalOverflow(page, viewport.name);
  await assertCriticalBoxesInsideViewport(page, viewport.name);
  await assertAnchorsResolve(page, viewport.name);
  await assertMobileMenu(page, viewport);
  await assertLoginDialog(page, viewport.name);

  if (viewport.name === "iphone-390") {
    await assertTouchLoginBackdrop(page, viewport.name);
    await assertThemePersistence(page);
    await assertChartInteraction(page, true);
  }
  if (viewport.name === "desktop") await assertChartInteraction(page, false);

  await assertNoHorizontalOverflow(page, `${viewport.name}:after-interactions`);

  const meaningfulErrors = browserErrors.filter((message) => !/favicon/iu.test(message));
  assert.deepEqual(meaningfulErrors, [], `${viewport.name}: browser errors: ${meaningfulErrors.join(" | ")}`);

  await context.close();
  console.log(`✓ ${viewport.name} ${viewport.width}x${viewport.height}`);
}

async function assertMobileEmulation(browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    screen: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  });
  const page = await context.newPage();
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.getByRole("heading", { level: 1 }).waitFor({ state: "visible" });

  await assertViewportMetadata(page, "mobile-emulation");
  await assertNoHorizontalOverflow(page, "mobile-emulation");
  await assertCriticalBoxesInsideViewport(page, "mobile-emulation");

  const metrics = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    clientWidth: document.documentElement.clientWidth,
    coarsePointer: window.matchMedia("(pointer: coarse)").matches,
  }));
  assert.ok(metrics.innerWidth >= 389 && metrics.innerWidth <= 391, `mobile-emulation: innerWidth ${metrics.innerWidth}`);
  assert.ok(metrics.clientWidth >= 389 && metrics.clientWidth <= 391, `mobile-emulation: clientWidth ${metrics.clientWidth}`);
  assert.equal(metrics.coarsePointer, true, "mobile-emulation: pointer must be coarse");

  await assertMobileMenu(page, { name: "mobile-emulation", width: 390, height: 844 });
  await assertChartInteraction(page, true);
  await context.close();
}

async function assertReducedMotion(browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { level: 1 }).waitFor({ state: "visible" });
  await assertNoHorizontalOverflow(page, "reduced-motion");

  const durations = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll("main *"));
    return nodes.flatMap((node) =>
      getComputedStyle(node)
        .animationDuration.split(",")
        .map((duration) => duration.trim())
        .filter(Boolean),
    );
  });

  const seconds = durations.map((duration) =>
    duration.endsWith("ms") ? Number.parseFloat(duration) / 1000 : Number.parseFloat(duration),
  );
  assert.ok(
    seconds.every((duration) => Number.isFinite(duration) && duration <= 0.001),
    "reduced-motion left a long animation active",
  );

  await context.close();
}

let server = null;
let browser = null;

try {
  server = startLocalServer();
  await waitForServer(BASE_URL);

  browser = await chromium.launch({ headless: true });
  const apiContext = await browser.newContext();
  await assertMarketPayload(apiContext);
  await apiContext.close();
  console.log("✓ market payload invariants");

  await assertAuthSameOrigin(browser);
  console.log("✓ auth remains same-origin");

  await assertClientFreshnessGuard(browser);
  console.log("✓ client market freshness guard");

  for (const viewport of viewports) {
    await runViewport(browser, viewport);
  }

  await assertMobileEmulation(browser);
  console.log("✓ mobile viewport emulation");

  await assertReducedMotion(browser);
  console.log("✓ prefers-reduced-motion");

  console.log("\nLanding regression: PASS");
} catch (error) {
  console.error("\nLanding regression: FAIL");
  console.error(error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  killServer(server);
}
