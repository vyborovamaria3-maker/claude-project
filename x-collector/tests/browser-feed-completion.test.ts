import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { collectArticles } from "../lib/trade/twitter-scraper";
import { HttpAccountQuotaError } from "../src/xactions/account-http-quota";

test("browser short feed persists observed batches without stopping recurring collection", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<article data-testid="tweet"><a href="/nasa/status/1878727153048777016"><time datetime="2026-10-12T00:00:00Z"></time></a><div data-testid="tweetText">fixture</div></article>`);
    let persisted = 0;
    const phases: string[] = [];
    const tweets = await collectArticles(page, 10, Date.now() + 15_000,
      async progress => { phases.push(progress.phase); },
      async batch => { persisted += batch.length; });
    assert.equal(tweets.length, 1);
    assert.equal(persisted, 1);
    assert.equal(phases.at(-1), "unverified_end", "coverage remains unverified without blocking the scheduled source");
  } finally { await browser.close(); }
});

test("explicit empty state and requested target both conclude a browser scan", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div data-testid="emptyState">Nothing found</div>');
    assert.deepEqual(await collectArticles(page, 10, Date.now() + 20_000), []);
    await page.setContent('<div data-testid="stillLoading">No content</div>');
    // No explicit empty state: let searchTweets inspect DOM and report
    // SEARCH_UNCONFIRMED rather than misreporting a verified feed end.
    assert.deepEqual(await collectArticles(page, 10, Date.now() + 20_000), []);
    await page.setContent('<article data-testid="tweet"><a href="/nasa/status/1878727153048777016"><time datetime="2026-10-12T00:00:00Z"></time></a></article>');
    assert.equal((await collectArticles(page, 1, Date.now() + 5_000)).length, 1);
  } finally { await browser.close(); }
});

test("browser scrolling reserves quota before each further navigation-like action",async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage();
    await page.setContent('<article data-testid="tweet"><a href="/nasa/status/1878727153048777016"><time datetime="2026-10-12T00:00:00Z"></time></a></article>');
    let calls=0,saved=0;
    await assert.rejects(collectArticles(page,10,Date.now()+15_000,
      undefined,async batch=>{saved+=batch.length;},
      async()=>{calls++;if(calls===2)throw new HttpAccountQuotaError();}),
      HttpAccountQuotaError);
    assert.equal(calls,2);
    assert.equal(saved,1,"saved posts remain durable when quota is exhausted");
  }finally{await browser.close();}
});
