import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium, devices } from "playwright";

const baseURL = process.env.BASE_URL || "http://127.0.0.1:3000";
const appDir = path.resolve("app");
const outputDir = path.resolve("test-results/full-route-audit");
const TEST_ACCESS_TOKEN = "full-route-backtest-token";

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else files.push(full);
  }
  return files;
}

function pageFileToRoute(file) {
  const rel = path.relative(appDir, file).replaceAll(path.sep, "/");
  if (!/(^|\/)page\.(tsx|ts|jsx|js)$/.test(rel)) return null;
  const withoutPage = rel.replace(/(^|\/)page\.(tsx|ts|jsx|js)$/, "");
  const rawSegments = withoutPage.split("/").filter(Boolean);
  if (rawSegments.some((segment) => segment === "api" || segment.startsWith("@") || segment.includes("[") || segment.includes("]"))) return null;
  const segments = rawSegments.filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")));
  return segments.length ? `/${segments.join("/")}` : "/";
}

async function discoverRoutes() {
  const files = await walk(appDir);
  const routes = files.map(pageFileToRoute).filter(Boolean);
  return [...new Set(routes)].sort();
}

function isGenericServerError(text) {
  return /Application error|Internal Server Error|Unhandled Runtime Error|This page could not be found/i.test(text);
}

async function evaluateStable(page) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(350);
      return await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        htmlWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body?.scrollWidth || 0,
        text: document.body?.innerText?.slice(0, 10000) || "",
        href: location.href,
        badHrefs: Array.from(document.querySelectorAll("a[href]"))
          .map((node) => node.getAttribute("href") || "")
          .filter((href) => /(^|[/?#])(undefined|null)([/?#]|$)/i.test(href)),
        controlsOutsideViewport: Array.from(document.querySelectorAll("input, select, textarea, button"))
          .filter((node) => {
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            if (style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0) return false;
            return rect.left < -2 || rect.right > document.documentElement.clientWidth + 2;
          })
          .slice(0, 20)
          .map((node) => `${node.tagName.toLowerCase()}#${node.id || ""}.${node.className || ""}`),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const redirectRace = /Execution context was destroyed|Target page, context or browser has been closed/i.test(message);
      if (!redirectRace || attempt === 4) throw error;
      await page.waitForTimeout(500);
    }
  }
  throw new Error("unreachable");
}

async function auditRoute(page, route, viewportName, failures) {
  const pageErrors = [];
  const badConsole = [];
  page.on("pageerror", (error) => pageErrors.push(error?.stack || error?.message || String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") badConsole.push(message.text());
  });

  let response;
  try {
    response = await page.goto(`${baseURL}${route}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch (error) {
    failures.push(`${viewportName} ${route}: navigation failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  if (!response) failures.push(`${viewportName} ${route}: no navigation response`);
  else if (response.status() >= 500) failures.push(`${viewportName} ${route}: HTTP ${response.status()}`);

  let state;
  try {
    state = await evaluateStable(page);
  } catch (error) {
    failures.push(`${viewportName} ${route}: unable to inspect stable page: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const widest = Math.max(state.htmlWidth, state.bodyWidth);
  if (widest > state.viewport + 2) failures.push(`${viewportName} ${route}: horizontal overflow ${widest}px > ${state.viewport}px`);
  if (isGenericServerError(state.text)) failures.push(`${viewportName} ${route}: generic server/runtime error visible`);
  if (state.badHrefs.length) failures.push(`${viewportName} ${route}: malformed hrefs ${JSON.stringify(state.badHrefs)}`);
  if (state.controlsOutsideViewport.length) failures.push(`${viewportName} ${route}: controls outside viewport ${JSON.stringify(state.controlsOutsideViewport)}`);
  if (pageErrors.length) failures.push(`${viewportName} ${route}: pageerror ${pageErrors.join(" | ")}`);

  const relevantConsole = badConsole.filter((line) => !/Failed to load resource|ERR_CONNECTION_REFUSED|fetch failed|NetworkError/i.test(line));
  if (relevantConsole.length) failures.push(`${viewportName} ${route}: console.error ${relevantConsole.slice(0, 5).join(" | ")}`);

  const finalPath = new URL(state.href).pathname;
  const redirect = finalPath !== route ? ` redirect=${finalPath}` : "";
  console.log(`AUDIT ${viewportName} ${route} status=${response?.status() ?? "none"} overflow=${widest - state.viewport}${redirect}`);
}

async function installAuthenticatedBacktestSession(context) {
  await context.addInitScript((token) => {
    window.localStorage.setItem("potapoff.access_token", token);
  }, TEST_ACCESS_TOKEN);

  await context.route("**/api/v1/auth/me", async (route) => {
    const authorization = route.request().headers().authorization || "";
    await route.fulfill({
      status: authorization === `Bearer ${TEST_ACCESS_TOKEN}` ? 200 : 401,
      contentType: "application/json",
      body: JSON.stringify(
        authorization === `Bearer ${TEST_ACCESS_TOKEN}`
          ? {
              id: "00000000-0000-0000-0000-000000000001",
              email: null,
              access_login: "route_audit",
              is_active: true,
              is_superuser: false,
            }
          : { detail: "Unauthorized" }
      ),
    });
  });
}

async function assertPrivateRouteGate(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    await page.goto(`${baseURL}/launch-dashboard`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForURL(/\/login(?:$|[?#])/, { timeout: 10_000 });
    assert.equal(new URL(page.url()).pathname, "/login");
    console.log("AUDIT access-gate unauthenticated /launch-dashboard redirect=/login");
  } finally {
    await context.close();
  }
}

async function run() {
  await fs.mkdir(outputDir, { recursive: true });
  const routes = await discoverRoutes();
  assert.ok(routes.length >= 10, `suspiciously few routes discovered: ${routes.length}`);
  assert.ok(routes.includes("/"), "root route was not discovered");
  console.log(`Discovered ${routes.length} static routes`);
  console.log(routes.join("\n"));

  const browser = await chromium.launch({ headless: true });
  const failures = [];
  try {
    await assertPrivateRouteGate(browser);
    const profiles = [
      ["desktop", { viewport: { width: 1440, height: 1000 }, locale: "ru-RU" }],
      ["iphone13", { ...devices["iPhone 13"], locale: "ru-RU" }],
    ];

    for (const [name, options] of profiles) {
      const context = await browser.newContext(options);
      await installAuthenticatedBacktestSession(context);
      try {
        for (const route of routes) {
          const page = await context.newPage();
          try {
            await auditRoute(page, route, name, failures);
          } catch (error) {
            failures.push(`${name} ${route}: unexpected audit error: ${error instanceof Error ? error.message : String(error)}`);
          } finally {
            await page.close();
          }
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  const report = { routes, failureCount: failures.length, failures };
  await fs.writeFile(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2));
  if (failures.length) {
    console.error(`FULL ROUTE AUDIT FOUND ${failures.length} ISSUE(S):`);
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exitCode = 1;
  } else {
    console.log("FULL ROUTE AUDIT PASSED");
  }
}

run().catch(async (error) => {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, "fatal.txt"), String(error?.stack || error));
  console.error(error);
  process.exitCode = 1;
});
