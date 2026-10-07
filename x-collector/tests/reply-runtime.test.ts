import assert from "node:assert/strict";
import { test, mock } from "node:test";
import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import { Pool } from "pg";
import { PGlite } from "@electric-sql/pglite";
import { chromium } from "playwright";
import { handleReplyRequest } from "../lib/reply/http";
import { issueToken } from "../lib/reply/auth";
import { accountFor, campaignFor } from "../lib/reply/service";
import { XClient, PublishUncertainError } from "../lib/reply/x-api";
import {
  collect,
  draftReplies,
  publishNext,
  reservePublication,
} from "../lib/reply/engine";
import { closePool } from "../lib/trade/pg";
import type { Tweet } from "../lib/reply/model";
const load = createRequire(__filename);
const bundled = load("@sparticuz/chromium")
  .default as typeof import("@sparticuz/chromium").default;

test("Reply Guy API, ownership, RAG pipeline, budgets, uncertainty and browser controls", async () => {
  const db = new PGlite();
  const env = { ...process.env };
  Object.assign(process.env, {
    DATABASE_URL: "postgresql://unused/reply_test",
    MASTER_KEY: "ab".repeat(32),
    JWT_SECRET: "test-secret-".repeat(5),
    LLM_PROVIDER: "compatible",
    LLM_BASE_URL: "https://llm.fixture/v1/",
    LLM_MODEL: "fixture-vision",
    LLM_EMBEDDING_MODEL: "fixture-embedding",
    REPLY_PUBLISH_ENABLED: "false",
    REPLY_X_AI_APPROVAL_REF: "fixture-approval-reference",
  });
  const query = async (sql: string, params: unknown[] = []) => {
    const r = await db.query(sql, params);
    return { rows: r.rows, rowCount: r.affectedRows || r.rows.length };
  };
  const queryMock = mock.method(Pool.prototype, "query", query),
    connectMock = mock.method(Pool.prototype, "connect", async () => ({
      query,
      release() {},
    }));
  const originalFetch = globalThis.fetch;
  const llmCalls: unknown[] = [];
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).startsWith("https://llm.fixture/")) {
        llmCalls.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify(
            String(input).includes("embeddings")
              ? { data: [{ embedding: [1, 0] }] }
              : {
                  choices: [
                    { message: { content: "A concise fixture reply" } },
                  ],
                },
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return originalFetch(input, init);
    },
  );
  const meMock = mock.method(
    XClient.prototype,
    "me",
    async function (this: XClient) {
      const credentials = (
        this as unknown as { credentials: { access_token: string } }
      ).credentials;
      return {
        id: credentials.access_token.includes("second") ? "200" : "100",
        username: credentials.access_token.includes("second")
          ? "second"
          : "first",
      };
    },
  );
  const sample: Tweet = {
    id: "1234567890123456789",
    author_id: "900",
    username: "recipient",
    text: '<script>throw new Error("untrusted")</script> source content',
    created_at: new Date(Date.now() - 120000).toISOString(),
    likes: 3,
    retweets: 1,
    followers: 100,
    is_reply: false,
    is_retweet: false,
    is_quote: false,
    images: ["https://pbs.twimg.com/media/fixture.jpg"],
  };
  const sourceMock = mock.method(XClient.prototype, "source", async () => ({
    tweets: [sample],
    newestId: sample.id,
  }));
  const publishMock = mock.method(
    XClient.prototype,
    "publish",
    async () => "9999999999999999999",
  );
  const server = http.createServer((req, res) => {
    void handleReplyRequest(req, res)
      .then((handled) => {
        if (!handled) {
          res.statusCode = 404;
          res.end();
        }
      })
      .catch(() => {
        res.statusCode = 500;
        res.end();
      });
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    for (const file of (await fs.readdir("migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      await db.exec(await fs.readFile("migrations/" + file, "utf8"));
    const jwt = await issueToken("12345"),
      otherJwt = await issueToken("67890");
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const address = server.address();
    assert(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    async function api(
      endpoint: string,
      method = "GET",
      body?: unknown,
      bearer = jwt,
    ) {
      const r = await originalFetch(base + "/api" + endpoint, {
        method,
        headers: {
          "X-Reply-Token": bearer,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, data: await r.json() };
    }
    assert.equal(
      (await api("/accounts", "GET", undefined, "invalid")).status,
      401,
    );
    const first = await api("/accounts", "POST", {
      access_token: "first-fixture-token",
      timezone: "Europe/Moscow",
    });
    assert.equal(first.status, 200);
    const accountId = String(first.data.id);
    assert.equal(first.data.status, "ready");
    assert(!JSON.stringify(first.data).includes("fixture-token"));
    assert(!("credentials_encrypted" in first.data));
    assert.equal(
      (
        await api(
          "/accounts/" + accountId,
          "PATCH",
          { status: "paused" },
          otherJwt,
        )
      ).status,
      404,
    );
    const lore = await api("/lore", "POST", {
      name: "Persona",
      style: "short thoughtful takes",
      bio: "Fixture bio",
    });
    assert.equal(lore.status, 200);
    assert.equal(
      (
        await api("/lore/" + lore.data.id, "PATCH", {
          name: "Changed",
          style: "concise",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await api(
          "/lore/" + lore.data.id,
          "PATCH",
          { style: "stolen" },
          otherJwt,
        )
      ).status,
      404,
    );
    for (let i = 0; i < 3; i++)
      assert.equal(
        (
          await api("/lore/" + lore.data.id + "/examples", "POST", {
            tweet_text: "example " + i,
            reply_text: "reply " + i,
          })
        ).status,
        200,
      );
    const created = await api("/campaigns", "POST", {
      account_id: accountId,
      lore_id: String(lore.data.id),
      settings: { sleep_enabled: false, hourly_limit: 1, daily_limit: 5 },
    });
    assert.equal(created.status, 200);
    const campaignId = String(created.data.id);
    assert.equal(
      (await api("/campaigns/" + campaignId + "/start", "POST", {})).status,
      409,
    );
    assert.equal(
      (
        await api("/campaigns/" + campaignId + "/sources", "POST", {
          type: "list",
          value: "123",
          priority: 10,
        })
      ).status,
      200,
    );
    assert.equal(
      (await api("/campaigns/" + campaignId + "/start", "POST", {})).status,
      200,
    );
    const account = await accountFor("1", accountId),
      campaign = await campaignFor("1", campaignId);
    await collect(campaign, account);
    await collect(campaign, account);
    assert.equal((await db.query("SELECT * FROM reply_drafts")).rows.length, 1);
    await draftReplies(campaign, account);
    const drafts = await api("/drafts");
    assert.equal(drafts.data[0].status, "review");
    const draftId = String(drafts.data[0].id);
    assert.equal(
      (await api("/drafts/" + draftId + "/approve", "POST", {})).status,
      409,
    );
    assert.equal(
      (
        await api("/consents", "POST", {
          author_id: "900",
          evidence: "Fixture recipient explicitly opted in",
          expires_at: new Date(Date.now() + 86400000).toISOString(),
        })
      ).status,
      200,
    );
    const approval = await api("/drafts/" + draftId + "/approve", "POST", {});
    assert.equal(approval.status, 200, JSON.stringify(approval.data));
    assert.equal(await reservePublication(accountId), null);
    process.env.REPLY_PUBLISH_ENABLED = "true";
    await publishNext(account);
    assert.equal((await api("/drafts")).data[0].status, "published");
    assert.equal(publishMock.mock.callCount(), 1);
    const campaignStats = await api("/campaigns/"+campaignId+"/stats");
    const accountStats = await api("/accounts/"+accountId+"/stats");
    assert.deepEqual(campaignStats.data,[{status:"published",count:1}]);
    assert.deepEqual(accountStats.data,campaignStats.data);
    assert.equal((await api("/campaigns/"+campaignId+"/stats","GET",undefined,otherJwt)).status,404);

    const prompt = llmCalls.find(
      (v) => (v as { messages?: unknown[] }).messages,
    ) as { messages: Array<{ content: unknown }> };
    assert(JSON.stringify(prompt).includes("Style examples"));
    assert(JSON.stringify(prompt).includes("image_url"));
    await db.query(
      "INSERT INTO reply_drafts(campaign_id,account_id,tweet_id,author_id,tweet_json,reply_text,status,approved_at) VALUES($1,$2,'2234567890123456789','900',$3::jsonb,'Second reply','approved',now())",
      [
        campaignId,
        accountId,
        JSON.stringify({ ...sample, id: "2234567890123456789" }),
      ],
    );
    await db.query("UPDATE reply_accounts SET next_reply_at=NULL WHERE id=$1", [
      accountId,
    ]);
    assert.equal(await reservePublication(accountId), null); // hourly cap is persisted.
    await api("/campaigns/" + campaignId, "PATCH", {
      settings: { hourly_limit: 2 },
    });
    publishMock.mock.mockImplementation(async () => {
      throw new PublishUncertainError();
    });
    await publishNext(account);
    const unknown = (await api("/drafts")).data.find(
      (d: { status: string }) => d.status === "uncertain",
    );
    assert(unknown);
    await publishNext(account);
    assert.equal(publishMock.mock.callCount(), 2); // uncertain POST is not repeated.
    assert.equal(
      (await api("/drafts/" + unknown.id + "/approve", "POST", {})).status,
      409,
    );
    assert.equal(
      (await api("/campaigns/" + campaignId + "/stop", "POST", {})).status,
      200,
    );
    assert.equal(await reservePublication(accountId), null);
    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.TEST_CHROMIUM_PATH ?? (await bundled.executablePath()),
      args: bundled.args,
    });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base + "/reply");
    await page.locator("#token").fill(jwt);
    await page
      .getByRole("button", { name: "Подключиться", exact: true })
      .click();
    await page.locator("#workspace").waitFor({ state: "visible" });
    for (const [label, view] of [
      ["Аккаунты", "accounts"],
      ["Персонажи", "lore"],
      ["Кампании", "campaigns"],
      ["Ответы", "drafts"],
      ["Согласия", "consents"],
      ["Статистика", "stats"],
      ["Алерты", "alerts"],
    ]) {
      await page
        .locator("#tabs")
        .getByRole("button", { name: label, exact: true })
        .click();
      await page.waitForFunction(
        (expected) =>
          document.querySelector<HTMLElement>("#content")?.dataset.view ===
          expected,
        view,
      );
    }
    assert.deepEqual(errors, []);
    assert.equal((await api("/token/revoke", "POST", {})).status, 200);
    assert.equal((await api("/accounts")).status, 401);
    await api(
      "/accounts/" + accountId,
      "DELETE",
      undefined,
      await issueToken("12345"),
    );
    assert.equal((await db.query("SELECT * FROM reply_drafts")).rows.length, 0);
    assert.equal(
      (await db.query("SELECT * FROM reply_campaigns")).rows.length,
      0,
    );
    // Controlled workload: ten accounts, fifty candidates each; no live X/LLM calls.
    const workload: Array<{account: Awaited<ReturnType<typeof accountFor>>; campaign: Awaited<ReturnType<typeof campaignFor>>}> = [];
    for (let i = 0; i < 10; i++) {
      const a = await db.query<{id: string}>(
        "INSERT INTO reply_accounts(user_id,x_user_id,credentials_encrypted,status) VALUES(1,$1,'fixture','ready') RETURNING id",
        ["load-" + i],
      );
      const c = await db.query<{id: string}>(
        "INSERT INTO reply_campaigns(user_id,account_id,lore_id,status,settings_json,filters_json) VALUES(1,$1,$2,'running',$3::jsonb,$4::jsonb) RETURNING id",
        [a.rows[0].id, lore.data.id, JSON.stringify({sleep_enabled:false,hourly_limit:2}), JSON.stringify({})],
      );
      for (let j = 0; j < 50; j++) await db.query(
        "INSERT INTO reply_drafts(campaign_id,account_id,tweet_id,author_id,tweet_json) VALUES($1,$2,$3,'900',$4::jsonb)",
        [c.rows[0].id,a.rows[0].id,String(10000+i*100+j),JSON.stringify({...sample,id:String(10000+i*100+j)})],
      );
      workload.push({account:await accountFor("1",String(a.rows[0].id)),campaign:await campaignFor("1",String(c.rows[0].id))});
    }
    const before = llmCalls.length;
    const started = performance.now();
    await Promise.all(workload.map(({campaign,account})=>draftReplies(campaign,account)));
    assert.equal(llmCalls.length-before,40); // 20 drafts, each embedding + generation.
    assert.equal((await db.query("SELECT id FROM reply_drafts WHERE status='review'")).rows.length,20);
    await Promise.all(workload.map(({campaign,account})=>draftReplies(campaign,account)));
    assert.equal(llmCalls.length-before,40); // Existing backlog causes zero extra LLM calls.
    await db.query("INSERT INTO reply_rate_limits(account_id,hour_epoch,count) VALUES($1,$2,2)",
      [workload[0].account.id,Math.floor(Date.now()/3600000)]);
    await db.query("UPDATE reply_drafts SET status='rejected' WHERE account_id=$1",[workload[0].account.id]);
    await draftReplies(workload[0].campaign,workload[0].account);
    assert.equal(llmCalls.length-before,40); // Exhausted quota also blocks paid work.
    await db.query("UPDATE reply_rate_limits SET count=0 WHERE account_id=$1",[workload[0].account.id]);
    await db.query(
      "INSERT INTO reply_drafts(campaign_id,account_id,tweet_id,author_id,tweet_json) VALUES($1,$2,'expiry-check','900',$3::jsonb)",
      [workload[0].campaign.id,workload[0].account.id,JSON.stringify({...sample,created_at:new Date(Date.now()-9.9*60000).toISOString()})],
    );
    await db.query("UPDATE reply_drafts SET status='rejected' WHERE account_id=$1 AND tweet_id<>'expiry-check'",[workload[0].account.id]);
    await draftReplies(workload[0].campaign,{...workload[0].account,next_reply_at:new Date(Date.now()+60000).toISOString()});
    assert.equal(llmCalls.length-before,40); // No paid draft that expires before its queue slot.
    console.log(`Controlled 10-account workload: 500 candidates, 20 drafts, 40 LLM requests, repeated cycle 0 additional requests; ${Math.round(performance.now()-started)}ms (PGlite fixtures)`);
  } finally {
    await browser?.close();
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    queryMock.mock.restore();
    connectMock.mock.restore();
    fetchMock.mock.restore();
    meMock.mock.restore();
    sourceMock.mock.restore();
    publishMock.mock.restore();
    await closePool();
    await db.close();
    for (const key of Object.keys(process.env))
      if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
  }
});
