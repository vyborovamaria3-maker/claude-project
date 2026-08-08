import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseURL = process.env.BASE_URL || "http://127.0.0.1:3000";
const axeSourcePath = process.env.AXE_SOURCE_PATH;
const routes = ["/auth", "/login", "/", "/launch-dashboard", "/trade-dashboard", "/trade/analysis", "/market-overview"];

const profiles = [
  { name: "phone", viewport: { width: 390, height: 844 }, isMobile: true },
  { name: "tablet", viewport: { width: 768, height: 1024 }, isMobile: false },
  { name: "desktop", viewport: { width: 1440, height: 900 }, isMobile: false },
];

assert.ok(axeSourcePath, "AXE_SOURCE_PATH is required");

async function run() {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const profile of profiles) {
      const context = await browser.newContext({
        viewport: profile.viewport,
        screen: profile.viewport,
        isMobile: profile.isMobile,
        hasTouch: profile.isMobile,
        locale: "ru-RU",
        colorScheme: "dark",
        reducedMotion: "reduce",
      });

      try {
        const page = await context.newPage();
        for (const route of routes) {
          const label = `${profile.name} ${route}`;
          const response = await page.goto(`${baseURL}${route}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
          assert.ok(response && response.status() < 400, `${label}: navigation failed with ${response?.status() ?? "no response"}`);
          await page.waitForTimeout(500);
          await page.addScriptTag({ path: axeSourcePath });

          const results = await page.evaluate(async () => {
            if (!window.axe) throw new Error("axe-core failed to load");
            return window.axe.run(document, {
              runOnly: {
                type: "tag",
                values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
              },
            });
          });

          const blocking = results.violations.filter((violation) => ["critical", "serious"].includes(violation.impact || ""));
          if (blocking.length) {
            console.error(`\n${label}: blocking accessibility violations`);
            for (const violation of blocking) {
              console.error(`- [${violation.impact}] ${violation.id}: ${violation.help}`);
              for (const node of violation.nodes.slice(0, 5)) console.error(`  ${node.target.join(" ")}: ${node.failureSummary || ""}`);
            }
          }
          assert.equal(blocking.length, 0, `${label}: ${blocking.length} critical/serious WCAG violations`);
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
