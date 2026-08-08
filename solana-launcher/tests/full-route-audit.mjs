import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium, devices } from "playwright";

const baseURL = process.env.BASE_URL || "http://127.0.0.1:3000";
const appDir = path.resolve("app");
const outputDir = path.resolve("test-results/full-route-audit");

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
  if (!/\/page\.(tsx|ts|jsx|js)$/.test(`/${rel}`)) return null;
  const rawSegments = rel.replace(/\/page\.(tsx|ts|jsx|js)$/, "").split("/").filter(Boolean);
  if (rawSegments.some((segment) => segment === "api" || segment.startsWith("@") || segment.includes("[") || segment.includes("]"))) return null;
  const segments = rawSegments.filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")));
  return `/${segments.join("/")}`.replace(/\/$/, "") || "/";
}

async function discoverRoutes() {
  const files = await walk(appDir);
  const routes = files.map(pageFileToRoute).filter(Boolean);
  return [...new Set(routes)].sort();
}

function isGenericServerError(text) {
  return /Application error|Internal Server Error|Unhandled Runtime Error|This page could not be found/i.test(text);
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

  await page.waitForTimeout(500);

  const state = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    htmlWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body?.scrollWidth || 0,
    text: document.body?.innerText?.slice(0, 10000) || "",
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

  const widest = Math.max(state.htmlWidth, state.bodyWidth);
  if (widest > state.viewport + 2) failures.push(`${viewportName} ${route}: horizontal overflow ${widest}px > ${state.viewport}px`);
  if (isGenericServerError(state.text)) failures.push(`${viewportName} ${route}: generic server/runtime error visible`);
  if (state.badHrefs.length) failures.push(`${viewportName} ${route}: malformed hrefs ${JSON.stringify(state.badHrefs)}`);
  if (state.controlsOutsideViewport.length) failures.push(`${viewportName} ${route}: controls outside viewport ${JSON.stringify(state.controlsOutsideViewport)}`);
  if (pageErrors.length) failures.push(`${viewportName} ${route}: pageerror ${pageErrors.join(" | ")}`);

  const relevantConsole = badConsole.filter((line) => !/Failed to load resource|ERR_CONNECTION_REFUSED|fetch failed|NetworkError/i.test(line));
  if (relevantConsole.length) failures.push(`${viewportName} ${route}: console.error ${relevantConsole.slice(0, 5).join(" | ")}`);

  console.log(`AUDIT ${viewportName} ${route} status=${response?.status() ?? "none"} overflow=${widest - state.viewport}`);
}

async function run() {
  await fs.mkdir(outputDir, { recursive: true });
  const routes = await discoverRoutes();
  assert.ok(routes.length >= 10, `suspiciously few routes discovered: ${routes.length}`);
  console.log(`Discovered ${routes.length} static routes`);
  console.log(routes.join("\n"));

  const browser = await chromium.launch({ headless: true });
  const failures = [];
  try {
    const profiles = [
      ["desktop", { viewport: { width: 1440, height: 1000 }, locale: "ru-RU" }],
      ["iphone13", { ...devices["iPhone 13"], locale: "ru-RU" }],
    ];

    for (const [name, options] of profiles) {
      const context = await browser.newContext(options);
      try {
        for (const route of routes) {
          const page = await context.newPage();
          try {
            await auditRoute(page, route, name, failures);
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

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
