import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

// Reuse the existing Playwright dependency without adding it to the admin server.
const require = createRequire(new URL("../../solana-launcher/package.json", import.meta.url));
const { chromium } = require("playwright");

const source = await readFile(
  new URL("../app/static/analysis-confirm-v5.js", import.meta.url), "utf8",
);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  try {
    await page.setContent("<style>.hidden{display:none}</style>");
    await page.evaluate(() => {
      window.__requests = [];
      window.fetch = async (url, options = {}) => {
        window.__requests.push({ url: String(url), method: options.method });
        return new Response("{}", { status: 200 });
      };
    });
    await page.addScriptTag({ content: source });

    async function begin(method, path = "/api/analysis-profiles/wallet/risk_score") {
      await page.evaluate(({ method, path }) => {
        window.__lastResult = window.fetch(path, { method, body: "{}" })
          .then(() => "accepted", error => error.name);
      }, { method, path });
      await page.getByRole("alertdialog").waitFor({ state: "visible" });
    }

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      await begin(method);
      await page.locator("#analysisConfirmCancel").click();
      assert.equal(await page.evaluate(() => window.__lastResult), "AbortError");
    }
    assert.equal(await page.evaluate(() => window.__requests.length), 0,
      "Canceled mutations must never reach the server");

    await begin("PUT");
    await page.locator("#analysisConfirmAccept").click();
    assert.equal(await page.evaluate(() => window.__lastResult), "accepted");
    assert.equal(await page.evaluate(() => window.__requests.length), 1);

    await begin("PATCH");
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => window.__lastResult), "AbortError");
    assert.equal(await page.evaluate(() => window.__requests.length), 1);

    await page.evaluate(() =>
      window.fetch("/api/analysis-profiles/wallet/backtest", { method: "POST" })
    );
    assert.equal(await page.evaluate(() => window.__requests.length), 2,
      "Backtest must not require mutation confirmation");

    await begin("DELETE");
    assert.equal(await page.evaluate(() => window.__requests.length), 2,
      "The previous confirmation must not bypass the next mutation");
    await page.locator("#analysisConfirmAccept").click();
    assert.equal(await page.evaluate(() => window.__lastResult), "accepted");
    assert.equal(await page.evaluate(() => window.__requests.length), 3);
  } finally {
    await page.close();
  }
} finally {
  await browser.close();
}
