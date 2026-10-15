import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { collectArticles } from "../lib/trade/twitter-scraper";
import { taskFailure } from "../lib/trade/task-errors";

test("browser feed without explicit end retains persisted batches but refuses success", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<article data-testid="tweet"><a href="/nasa/status/1878727153048777016"><time datetime="2026-10-12T00:00:00Z"></time></a><div data-testid="tweetText">fixture</div></article>`);
    let persisted = 0;
    await assert.rejects(
      collectArticles(page, 10, Date.now() + 15_000, undefined, async batch => { persisted += batch.length; }),
      /BROWSER_END_UNVERIFIED: 1 observed, target 10/,
    );
    assert.equal(persisted, 1);
    const fail = taskFailure(new Error("BROWSER_END_UNVERIFIED: 1 observed, target 10; no explicit end signal"));
    assert.equal(fail.code, "BROWSER_END_UNVERIFIED");
    assert.equal(fail.permanent, false);
  } finally { await browser.close(); }
});

test("explicit empty state and requested target both conclude a browser scan", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div data-testid="emptyState">Nothing found</div>');
    assert.deepEqual(await collectArticles(page, 10, Date.now() + 5_000), []);
    await page.setContent('<div data-testid="stillLoading">No content</div>');
    // No explicit empty state: let searchTweets inspect DOM and report
    // SEARCH_UNCONFIRMED rather than misreporting a verified feed end.
    assert.deepEqual(await collectArticles(page, 10, Date.now() + 5_000), []);
    await page.setContent('<article data-testid="tweet"><a href="/nasa/status/1878727153048777016"><time datetime="2026-10-12T00:00:00Z"></time></a></article>');
    assert.equal((await collectArticles(page, 1, Date.now() + 5_000)).length, 1);
  } finally { await browser.close(); }
});
