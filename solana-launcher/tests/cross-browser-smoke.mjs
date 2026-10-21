import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const baseURL = process.env.BASE_URL || "http://127.0.0.1:3000";
const browserTypes = { chromium, firefox, webkit };
const routes = ["/login", "/", "/trade-dashboard"];

async function runBrowser(name, type) {
  const browser = await type.launch({ headless: true });
  try {
    const page = await browser.newPage();
    try {
      for (const route of routes) {
        const pageErrors = [];
        const onError = error => pageErrors.push(error.message);
        page.on("pageerror", onError);
        try {
          const response = await page.goto(baseURL + route, {
            waitUntil: "domcontentloaded",
          });
          assert(response && response.status() < 500,
            `${name} ${route}: application returned HTTP ${response?.status()}`);
          assert.deepEqual(pageErrors, [], `${name} ${route}: browser runtime failed`);
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
}

for (const [name, type] of Object.entries(browserTypes)) {
  await runBrowser(name, type);
}
