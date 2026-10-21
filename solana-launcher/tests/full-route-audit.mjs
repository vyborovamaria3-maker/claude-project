import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const baseURL = process.env.BASE_URL || "http://127.0.0.1:3000";
const appDir = path.resolve("app");

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
  const parts = rel.replace(/(^|\/)page\.(tsx|ts|jsx|js)$/, "")
    .split("/").filter(Boolean);
  if (parts.some(part =>
    part === "api" || part.startsWith("@") || part.includes("[") || part.includes("]"))) {
    return null;
  }
  const route = parts.filter(part => !(part.startsWith("(") && part.endsWith(")")));
  const pathname = route.length ? "/" + route.join("/") : "/";
  // This local-only page intentionally returns 404 in production.
  return pathname === "/tg-collector" ? null : pathname;
}

async function run() {
  const routes = [...new Set((await walk(appDir)).map(pageFileToRoute).filter(Boolean))].sort();
  assert(routes.includes("/"), "Root route discovery failed");

  const browser = await chromium.launch({ headless: true });
  const failures = [];
  try {
    const page = await browser.newPage();
    try {
      for (const route of routes) {
        const pageErrors = [];
        const onError = error => pageErrors.push(error.message);
        page.on("pageerror", onError);
        try {
          const response = await page.goto(baseURL + route, {
            waitUntil: "domcontentloaded", timeout: 30_000,
          });
          await page.waitForLoadState("load", { timeout: 15_000 });
          if (!response || response.status() >= 400) {
            failures.push(`${route}: HTTP ${response?.status() ?? "no response"}`);
          }
          if (pageErrors.length) failures.push(`${route}: ${pageErrors.join(" | ")}`);
        } catch (error) {
          failures.push(`${route}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          page.off("pageerror", onError);
        }
      }
    } finally {
      await page.close();
    }
  } finally {
    await browser.close();
  }

  const outputDir = path.resolve("test-results/full-route-audit");
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, "report.json"),
    JSON.stringify({ routes, failureCount: failures.length, failures }, null, 2));

  if (failures.length) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  }
  console.log(`Checked ${routes.length} routes, ${failures.length} failures`);
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
