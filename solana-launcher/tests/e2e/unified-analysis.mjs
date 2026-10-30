import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const catalog = JSON.parse(await readFile(new URL("../../lib/trade/analysis-feature-provenance.json", import.meta.url), "utf8"));

export async function checkUnifiedDetails(page, baseUrl, mint) {
  const navigation = page.locator('[data-tag="layout.nav"]');
  for (const path of ["/trade/kols-twitter", "/trade/leaderboard", "/trade/history"]) {
    assert.equal(await navigation.locator(`a[href="${path}"]`).count(), 0, "Legacy analytics must not remain in the main menu");
  }
  for (const path of ["/trade/analysis", "/tginvite"]) {
    assert.equal(await navigation.locator(`a[href="${path}"]`).count(), 1, "Analysis and Telegram tools must remain accessible");
  }
  const dialog = page.getByRole("dialog");
  const tables = dialog.locator('[data-tag="trade.social.metrics"]');
  await page.route(url => url.pathname.startsWith("/api/") || url.pathname.startsWith("/fastapi/"), route =>
    route.fulfill({ status: 503, json: { error: "source_unavailable" } })
  );
  const groupRows = (title) => tables.locator(".overflow-hidden.rounded-xl").filter({ has: page.getByText(title, { exact: true }) }).locator(".divide-y > div");
  const fullReport = () => page.getByRole("button", { name: /Открыть полный отчёт/ }).click();
  const close = async () => {
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
  };

  // No token and no source responses must still expose the entire real catalog.
  await fullReport();
  await tables.waitFor({ state: "visible" });
  let count = 0;
  for (const [title, group] of Object.entries(catalog.groups)) {
    const rows = groupRows(title);
    assert.equal(await rows.count(), group.labels.length, `${title}: all catalog labels must be visible`);
    assert.deepEqual(await rows.locator(".text-content-muted").allTextContents(), group.labels);
    assert.deepEqual(await rows.locator(".font-mono").allTextContents(), group.labels.map(() => "—"));
    count += group.labels.length;
  }
  assert.equal(count, 141);
  for (const [label, count] of [["Cross-platform / Timing", 27], ["Price event evidence", 14]]) {
    await dialog.getByRole("button", { name: label, exact: true }).click();
    assert.equal(await tables.locator(".divide-y > div").count(), count);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), "Mobile dialog must fit its viewport");
  await close();
  await page.setViewportSize({ width: 1280, height: 900 });

  let xMint = null;
  await page.route(url => url.pathname.startsWith("/api/") || url.pathname.startsWith("/fastapi/"), async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/trade/dev-twitter") {
      xMint = url.searchParams.get("mint");
      // Synthetic source fixture: verifies API -> computed metric -> visible value.
      await route.fulfill({ json: {
        symbol: "TEST", totalTweets: 7, totalViews: 70, totalLikes: 3, totalRetweets: 2,
        uniqueMentioners: 1, botRiskScore: 0, anomalyCount: 0, topTweets: [{ author: "fixture", text: "Synthetic token launch discussion with enough text to create evidence." }], shillers: [],
        aggregated: { totalEngagement: 5, engagementRate: 5 / 70, verifiedAuthors: 0, botRatio: 0 },
      } });
    } else {
      await route.fulfill({ status: 503, json: { error: "source_unavailable" } });
    }
  });
  await page.locator('[data-tag="trade.search_input"]').fill(mint);
  await page.locator('[data-tag="trade.search_submit"]').click();
  await page.waitForURL(url => url.searchParams.get("mint") === mint);
  const detailPosts = [];
  const captureDetailPosts = request => {
    if (request.method() === "POST") detailPosts.push(new URL(request.url()).pathname);
  };
  page.on("request", captureDetailPosts);
  await page.locator("article").first().getByRole("button", { name: /Открыть подробно/ }).click();
  await page.waitForFunction(() => {
    const tables = document.querySelector('[data-tag="trade.social.metrics"]');
    return tables && [...tables.querySelectorAll(".divide-y > div")].some(row =>
      row.querySelector(".text-content-muted")?.textContent === "Mentions" && row.querySelector(".font-mono")?.textContent === "7"
    );
  });
  assert.deepEqual(detailPosts, [], "Opening a source detail must not trigger automatic AI POST");
  page.off("request", captureDetailPosts);
  assert.equal(xMint, mint, "Selected mint must reach the existing X source");
  const embeddedMint = "So11111111111111111111111111111111111111112";
  const socialAiPosts = [];
  const captureSocialAiPosts = request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/trade/social-ai") {
      socialAiPosts.push(request);
    }
  };
  page.on("request", captureSocialAiPosts);
  const embeddedSourceRequest = page.waitForRequest(request =>
    new URL(request.url()).pathname === "/api/trade/dev-twitter"
    && new URL(request.url()).searchParams.get("mint") === embeddedMint
  );
  const manualSocialAiResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname === "/api/trade/social-ai"
  );
  await dialog.getByPlaceholder("Вставь contract").fill(embeddedMint);
  await dialog.getByRole("button", { name: "Анализ", exact: true }).click();
  await page.waitForURL(url => url.searchParams.get("mint") === embeddedMint);
  await embeddedSourceRequest;
  assert(await dialog.evaluate(element => document.activeElement !== element),
    "Synchronizing the embedded mint must not reset focus to the dialog root");
  const socialAiResponse = await manualSocialAiResponse;
  assert.equal(xMint, embeddedMint, "Embedded mint changes must reach the source API");
  assert.equal(socialAiPosts.length, 1, "Changing the embedded mint must not cancel or duplicate the explicit Social AI POST");
  assert.equal(socialAiPosts[0].postDataJSON().mint, embeddedMint, "Explicit AI must analyze the newly selected mint");
  assert.equal(socialAiResponse.status(), 503, "The controlled unavailable fixture should be returned without hiding the request");
  page.off("request", captureSocialAiPosts);
  await dialog.getByRole("button", { name: "Cross-platform / Timing", exact: true }).click();
  for (const label of ["Cross-platform score", "Cross matched share", "Both platforms active"]) {
    const row = groupRows("Cross-platform / Timing").filter({ has: page.getByText(label, { exact: true }) });
    assert.equal(await row.locator(".font-mono").textContent(), "—", `${label}: an unavailable counterpart is unknown`);
  }
  await dialog.getByRole("button", { name: "Telegram", exact: true }).click();
  await tables.getByText("TG score", { exact: true }).waitFor({ state: "visible" });
  assert.deepEqual(await groupRows("Telegram").locator(".font-mono").allTextContents(), catalog.groups.Telegram.labels.map(() => "—"), "Unavailable Telegram must not show invented values");
  await close();

  // Override the earlier successful X fixture: this scenario must verify the
  // no-source state, not reuse synthetic X data from the preceding detail test.
  await page.route(url => url.pathname === "/api/trade/dev-twitter", async route =>
    route.fulfill({ status: 503, json: { error: "source_unavailable" } })
  );

  // Opening the full report may load deterministic sources, but it must not start AI generation.
  const aiPosts = [];
  const captureAiPosts = request => {
    if (request.method() === "POST") aiPosts.push(new URL(request.url()).pathname);
  };
  page.on("request", captureAiPosts);
  await fullReport();
  await dialog.getByText("Нет данных X и Telegram", { exact: true }).waitFor({ state: "visible" });
  await dialog.getByRole("button", { name: "Запустить AI", exact: true }).waitFor({ state: "visible" });
  assert.deepEqual(aiPosts, [], "Opening the AI report must not trigger an automatic POST");
  assert.deepEqual(await groupRows("Growth / Quality / Manipulation").locator(".font-mono").allTextContents(), catalog.groups["Growth / Quality / Manipulation"].labels.map(() => "—"));
  for (const label of ["Cross-platform score", "Cross matched share", "Both platforms active"]) {
    const row = groupRows("Cross-platform / Timing").filter({ has: page.getByText(label, { exact: true }) });
    assert.equal(await row.locator(".font-mono").textContent(), "—", `${label}: missing social inputs must remain unknown`);
  }
  await close();
  page.off("request", captureAiPosts);

  // A lightweight same-origin frame isolates shell navigation from legacy APIs.
  await page.route(url => url.pathname === "/trade/analysis/onchain", async route => {
    if (!route.request().isNavigationRequest()) return route.continue();
    await route.fulfill({ contentType: "text/html", body: '<button id="inside">Legacy controls</button>' });
  });
  await page.getByRole("button", { name: "Кошельки и DEV", exact: false }).click();
  const frame = page.frameLocator('iframe[title="Полный анализ кошельков"]');
  await frame.locator("#inside").waitFor();
  await frame.locator("#inside").focus();
  await frame.locator("#inside").press("Shift+Tab");
  assert(await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return !!dialog?.contains(document.activeElement) && document.activeElement?.tagName !== "IFRAME";
  }), "Shift+Tab from the first iframe control must return focus to the parent dialog");
  await page.keyboard.press("Tab");
  await frame.locator("#inside").focus();
  await frame.locator("#inside").press("Tab");
  assert(await page.getByRole("button", { name: "Закрыть подробный анализ", exact: true }).evaluate(element => element === document.activeElement),
    "Tab from the last iframe control must wrap to the dialog close button");
  const nextMint = mint;
  await frame.locator("#inside").evaluate((_, next) => history.replaceState(null, "", `?mint=${next}`), nextMint);
  await page.waitForURL(url => url.searchParams.get("mint") === nextMint);
  await frame.locator("#inside").focus();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await page.locator('[data-tag="trade.search_input"]').inputValue(), nextMint);

  await page.getByRole("button", { name: "Кошельки и DEV", exact: false }).click();
  await frame.locator("#inside").waitFor();
  await frame.locator("#inside").evaluate((_, next) => history.replaceState(null, "", `/trade/analysis?mint=${next}`), mint);
  await page.waitForURL(url => url.searchParams.get("mint") === mint);
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await page.locator("iframe").count(), 0, "Legacy Analyze links must return to the outer overview");

  for (const [section, label] of [["kols", "KOL / Smart Money"], ["leaderboard", "Leaderboard"], ["history", "История запусков"]]) {
    await page.goto(`${baseUrl}/trade/analysis?section=${section}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("dialog", { name: label, exact: true }).waitFor();
    await page.getByRole("button", { name: "Закрыть подробный анализ", exact: true }).click();
    await page.waitForURL(url => !url.searchParams.has("section"), { waitUntil: "domcontentloaded" });
    assert.equal(await page.getByRole("dialog").count(), 0, "Closing an admin deep link must return to the overview");
  }
}
