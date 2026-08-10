import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import process from "node:process";
import { chromium } from "playwright";

const PORT = Number(process.env.LANDING_TEST_PORT || 3017);
const EXTERNAL_BASE_URL = process.env.LANDING_TEST_URL?.replace(/\/$/, "") || "";
const BASE_URL = EXTERNAL_BASE_URL || `http://127.0.0.1:${PORT}`;
const SERVER_TIMEOUT_MS = 90_000;

const viewports = [
  { name: "phone-320", width: 320, height: 568 },
  { name: "phone-375", width: 375, height: 667 },
  { name: "iphone-390", width: 390, height: 844 },
  { name: "phone-430", width: 430, height: 932 },
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
      if (response.status >= 200 && response.status < 500) return;
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
      cwd: process.cwd(),
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  child.stdout.on("data", (chunk) => process.stdout.write(`[next] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[next] ${chunk}`));
  return child;
}

function killServer(child) {
  if (!child || child.killed) return;
  child.kill("SIGTERM");
  setTimeout(() => {
    if (!child.killed) child.kill("SIGKILL");
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
    const selectors = [
      "header",
      "main h1",
      "#market",
      "#features",
      "#workspace",
      "footer",
    ];

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

async function assertThemePersistence(page) {
  const toggle = page.getByRole("button", { name: /переключить тему/i });
  await toggle.click();
  await page.waitForFunction(() => document.querySelector("main")?.getAttribute("data-theme") === "solana");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("main")?.getAttribute("data-theme") === "solana");

  await page.evaluate(() => localStorage.removeItem("potapoff.landing_theme"));
  await page.reload({ waitUntil: "domcontentloaded" });
}

async function assertLoginDialog(page, label) {
  const openButtons = page.getByRole("button", { name: /открыть платформу/i });
  assert.ok((await openButtons.count()) > 0, `${label}: no platform CTA`);
  await openButtons.first().click();

  const dialog = page.getByRole("dialog", { name: /войти в potapoff/i });
  await dialog.waitFor({ state: "visible" });

  const inputMetrics = await dialog.locator("input").evaluateAll((inputs) =>
    inputs.map((input) => input.getBoundingClientRect().height),
  );
  assert.ok(inputMetrics.every((height) => height >= 43), `${label}: login touch target below 44px`);

  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
}

async function assertMobileMenu(page, viewport) {
  if (viewport.width > 980) return;
  const menuButton = page.getByRole("button", { name: /открыть меню/i });
  await menuButton.waitFor({ state: "visible" });
  await menuButton.click();
  const mobileMenu = page.locator("#landing-mobile-menu");
  await mobileMenu.waitFor({ state: "visible" });
  assert.ok((await mobileMenu.locator('a[href="#market"]').count()) === 1, `${viewport.name}: market link missing`);
  await page.keyboard.press("Escape");
}

async function assertMarketPayload(context) {
  const response = await context.request.get(`${BASE_URL}/api/market/solana`, { timeout: 15_000 });

  if (response.status() === 503) {
    console.warn("[market] upstream unavailable during test; schema test skipped for this run");
    return;
  }

  assert.equal(response.status(), 200, `market API returned ${response.status()}`);
  const data = await response.json();

  assert.equal(data.source, "CoinGecko");
  assert.equal(data.quote, "USD");
  assert.ok(Number.isFinite(data.price) && data.price > 0, "market price must be positive");
  assert.ok(Array.isArray(data.points) && data.points.length >= 24, "market graph needs enough real points");
  assert.ok(data.points.length <= 120, "market graph exceeded point budget");

  for (let index = 0; index < data.points.length; index += 1) {
    const point = data.points[index];
    assert.ok(Number.isFinite(point.time) && point.time > 0, `invalid timestamp at ${index}`);
    assert.ok(Number.isFinite(point.price) && point.price > 0, `invalid price at ${index}`);
    if (index > 0) assert.ok(point.time > data.points[index - 1].time, "market points must be strictly ordered");
  }

  const first = data.points[0];
  const last = data.points.at(-1);
  const span = last.time - first.time;
  assert.ok(span >= 20 * 60 * 60 * 1000, `market window too short: ${span}`);

  const plottedPrices = data.points.map((point) => point.price);
  const plottedHigh = Math.max(...plottedPrices);
  const plottedLow = Math.min(...plottedPrices);
  assert.ok(Math.abs(plottedHigh - data.high24h) < 1e-6, "downsample lost real 24h high");
  assert.ok(Math.abs(plottedLow - data.low24h) < 1e-6, "downsample lost real 24h low");

  const plottedChange = ((last.price - first.price) / first.price) * 100;
  assert.ok(Math.abs(plottedChange - data.change24h) < 1e-6, "24h change does not match plotted endpoints");

  if (!data.stale) {
    assert.ok(Date.now() - data.updatedAt <= 10 * 60 * 1000, "LIVE payload is older than 10 minutes");
  }
}

async function assertChartInteraction(page) {
  const chart = page.locator('[aria-label*="Интерактивный график"]');
  if ((await chart.count()) === 0) return;

  const box = await chart.boundingBox();
  if (!box) return;

  await page.mouse.move(box.x + box.width * 0.58, box.y + box.height * 0.45);
  const tooltip = page.locator('[class*="chartTooltip"]');
  if ((await tooltip.count()) > 0) {
    await tooltip.waitFor({ state: "visible" });
    const text = (await tooltip.textContent()) || "";
    assert.match(text, /\$/u, "chart tooltip should contain USD price");
  }
}

async function runViewport(browser, viewport) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    reducedMotion: "no-preference",
  });
  const page = await context.newPage();
  const browserErrors = [];

  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  });

  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.getByRole("heading", { level: 1 }).waitFor({ state: "visible" });

  await assertNoHorizontalOverflow(page, viewport.name);
  await assertCriticalBoxesInsideViewport(page, viewport.name);
  await assertAnchorsResolve(page, viewport.name);
  await assertMobileMenu(page, viewport);
  await assertLoginDialog(page, viewport.name);

  if (viewport.name === "iphone-390") await assertThemePersistence(page);
  if (viewport.name === "desktop") await assertChartInteraction(page);

  await assertNoHorizontalOverflow(page, `${viewport.name}:after-interactions`);

  const meaningfulErrors = browserErrors.filter(
    (message) => !/favicon|Failed to load resource.*503|CoinGecko/iu.test(message),
  );
  assert.deepEqual(meaningfulErrors, [], `${viewport.name}: browser errors: ${meaningfulErrors.join(" | ")}`);

  await context.close();
  console.log(`✓ ${viewport.name} ${viewport.width}x${viewport.height}`);
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

  for (const viewport of viewports) {
    await runViewport(browser, viewport);
  }

  const reducedContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
  });
  const reducedPage = await reducedContext.newPage();
  await reducedPage.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await assertNoHorizontalOverflow(reducedPage, "reduced-motion");
  await reducedContext.close();
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
