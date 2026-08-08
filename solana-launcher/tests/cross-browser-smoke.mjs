import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const baseURL = process.env.BASE_URL || "http://127.0.0.1:3000";
const browsers = [
  ["chromium", chromium],
  ["firefox", firefox],
  ["webkit", webkit],
];
const profiles = [
  { name: "mobile", viewport: { width: 390, height: 844 }, isMobile: true },
  { name: "desktop", viewport: { width: 1440, height: 900 }, isMobile: false },
];
const routes = ["/login", "/", "/trade-dashboard"];

async function runBrowser(name, browserType) {
  const browser = await browserType.launch({ headless: true });
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
        const errors = [];
        page.on("pageerror", (error) => errors.push(error?.stack || error?.message || String(error)));

        for (const route of routes) {
          errors.length = 0;
          const label = `${name}/${profile.name} ${route}`;
          const response = await page.goto(`${baseURL}${route}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
          assert.ok(response && response.status() < 400, `${label}: HTTP ${response?.status() ?? "no response"}`);
          await page.waitForTimeout(350);
          const dimensions = await page.evaluate(() => ({
            viewport: document.documentElement.clientWidth,
            width: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
          }));
          assert.ok(dimensions.width <= dimensions.viewport + 2, `${label}: horizontal overflow ${dimensions.width}px > ${dimensions.viewport}px`);
          assert.equal(errors.length, 0, `${label}: page errors:\n${errors.join("\n")}`);
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}

for (const [name, browserType] of browsers) {
  console.log(`cross-browser smoke: ${name}`);
  await runBrowser(name, browserType);
}

console.log("cross-browser smoke passed");
