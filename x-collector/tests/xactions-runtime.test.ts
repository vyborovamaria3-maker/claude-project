import test from "node:test";
import assert from "node:assert/strict";
import type { ScrapeAuthState } from "../lib/trade/twitter-scraper";
import { cookiesFromStorageState } from "../src/xactions/session";
import { createHttpQuotaGate, HttpAccountQuotaError } from "../src/xactions/account-http-quota";
import { isXActionsEligible } from "../src/xactions/task";
import { assertXActionsRuntime, createXActionsRuntime } from "../src/xactions/runtime";
import { MembersPayload, parseTaskPayload } from "../lib/trade/schemas";

function storage(): ScrapeAuthState {
  return {
    cookies: [
      { name: "auth_token", value: "secret", domain: ".x.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "None" },
      { name: "ct0", value: "csrf", domain: ".x.com", path: "/", expires: -1, httpOnly: false, secure: true, sameSite: "None" },
      { name: "evil", value: "outside", domain: ".example.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "None" },
    ],
    origins: [],
  };
}

test("Playwright cookies are restricted to X and never accept arbitrary domains", () => {
  const cookies = cookiesFromStorageState(storage());
  assert.match(cookies, /auth_token=secret/);
  assert.match(cookies, /ct0=csrf/);
  assert.ok(!cookies.includes("outside"));
  assert.throws(() => cookiesFromStorageState({ cookies: [], origins: [] }), /AUTH_REQUIRED/);
});

test("HTTP quota gate consumes weighted reservation, then extra shared quota", async () => {
  let reservations = 0;
  const gate = createHttpQuotaGate("timeline", async () => { reservations++; return reservations <= 2; });
  for (let i = 0; i < 5; i++) await gate();
  assert.equal(reservations, 0);
  await gate();
  await gate();
  assert.equal(reservations, 2);
  await assert.rejects(gate(), HttpAccountQuotaError);
});

test("engine selection excludes historical/discovery and keyword search", () => {
  assert.equal(isXActionsEligible("profile", { handle: "NASA" }), true);
  assert.equal(isXActionsEligible("members", { list_id: "1878727153048777016" }), true);
  assert.equal(isXActionsEligible("members", { list_id: "invalid" }), false);
  assert.equal(isXActionsEligible("timeline", { handle: "NASA", limit: 20 }), true);
  assert.equal(isXActionsEligible("search", { query: "list:1945268064792068152" }), true);
  assert.equal(isXActionsEligible("search", { query: "solana" }), false);
  assert.equal(isXActionsEligible("search", { query: "list:1945268064792068152", history_run_id: "test" }), false);
  assert.equal(isXActionsEligible("search", { query: "list:1945268064792068152", list_source_id: "123" }), false);
  // Regression: archive timeline tasks must update legacy history_runs and
  // numeric max_id, so HTTP must never claim them.
  assert.equal(isXActionsEligible("timeline", { handle: "NASA", limit: 100, history_run_id: "archive-1" }), false);
  assert.equal(isXActionsEligible("timeline", { handle: "NASA", limit: 100, history_max_id: "1234567890" }), false);
  assert.equal(isXActionsEligible("profile", { handle: "NASA", history_since: "2026-01-01" }), false);
  assert.equal(isXActionsEligible("timeline", { handle: "NASA", discovery_source: "three-lists" }), false);
});

test("runtime enforces Node requirement only for explicit XActions path", () => {
  assert.throws(() => assertXActionsRuntime("20.18.0"), /Node.js/);
  assert.doesNotThrow(() => assertXActionsRuntime("22.12.0"));
  assert.doesNotThrow(() => assertXActionsRuntime("24.0.0"));
});

test("injected HTTP client receives cookies, no signing/refresh and no network by default", async () => {
  if (Number(process.versions.node.split(".")[0]) < 22) return;
  let init: Record<string, unknown> | null = null;
  class Stub {
    constructor(opts: Record<string, unknown>) { init = opts; }
    async graphql() { return { data: { user: { result: {} } } }; }
  }
  const engine = await createXActionsRuntime({
    state: storage(), proxy: { server: "socks5://127.0.0.1:9050" },
    signal: new AbortController().signal,
    beforeRequest: async () => { throw new Error("no outgoing calls expected"); },
    loadModule: async () => ({
      TwitterHttpClient: Stub,
      GRAPHQL: {
        UserByScreenName: { queryId: "u", operationName: "UserByScreenName" },
        UserTweets: { queryId: "t", operationName: "UserTweets" },
        ListTimeline: { queryId: "l", operationName: "ListLatestTweetsTimeline" },
        ListMembers: { queryId: "m", operationName: "ListMembers" },
        SearchTimeline: { queryId: "s", operationName: "SearchTimeline" },
      },
      parseUserData: () => ({ username: "NASA", name: "NASA" }),
      parseTimelineInstructions: () => ({ tweets: [], cursor: null }),
      userTimelineInstructions: () => [],
      parseUserList: () => ({ users: [], cursor: null }),
    }),
  });
  assert.equal((await engine.profile("NASA")).handle, "NASA");
  const opts = init as unknown as Record<string, unknown>;
  assert.equal(opts.transactionId, false);
  assert.equal(opts.autoRefreshQueryIds, false);
  assert.equal(opts.maxRetries, 0);
  assert.equal(typeof opts.fetch, "function");
  assert.ok(String(opts.cookies).includes("auth_token="));
  await assert.rejects((opts.fetch as typeof fetch)("https://example.com/private"), /not x.com/);
});

test("members task accepts only a numeric list ID and bounded requested limit", () => {
  const payload = MembersPayload.parse({ list_id: "953048248406519809", limit: 75 });
  assert.equal(payload.list_id, "953048248406519809");
  assert.equal(payload.limit, 75);
  assert.throws(() => parseTaskPayload("members", { list_id: "bad-list" }));
  assert.throws(() => parseTaskPayload("members", { list_id: "953048248406519809", limit: 5000 }));
});
