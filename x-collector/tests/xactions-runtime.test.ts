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

test("HTTP quota gate precharges only first weighted call, then charges each extra call", async () => {
  const weights: number[] = [];
  const gate = createHttpQuotaGate("timeline", async weight => {
    weights.push(weight);
    return weights.length <= 2;
  });
  await gate();
  assert.deepEqual(weights, []);
  await gate();
  await gate();
  assert.deepEqual(weights, [5, 5]);
  await assert.rejects(gate(), HttpAccountQuotaError);
  assert.deepEqual(weights, [5, 5, 5]);
  const profileWeights: number[] = [];
  const profileGate = createHttpQuotaGate("profile", async weight => {
    profileWeights.push(weight); return true;
  });
  await profileGate();
  await profileGate();
  assert.deepEqual(profileWeights, [1]);
});

test("engine selection excludes historical/discovery and keyword search", () => {
  assert.equal(isXActionsEligible("profile", { handle: "NASA" }), true);
  assert.equal(isXActionsEligible("members", { list_id: "1878727153048777016" }), true);
  assert.equal(isXActionsEligible("members", { list_id: "invalid" }), false);
  assert.equal(isXActionsEligible("timeline", { handle: "NASA", limit: 20 }), true);
  assert.equal(isXActionsEligible("search", { query: "list:1945268064792068152" }), true);
  assert.equal(isXActionsEligible("search", { query: "list:1945268064792068152", sort: "latest" }), true);
  assert.equal(isXActionsEligible("search", { query: "list:1945268064792068152", sort: "top" }), false);
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

test("historical routing survives Zod stripping unknown fields", () => {
  const original = { handle: "NASA", limit: 20, history_run_id: "archived-run" };
  const parsed = parseTaskPayload("timeline", original);
  assert.equal(Object.hasOwn(parsed, "history_run_id"), false);
  assert.equal(isXActionsEligible("timeline", parsed, JSON.stringify(original)), false);
  assert.equal(isXActionsEligible("timeline", parsed, original), false);
  assert.equal(isXActionsEligible("timeline", parsed), true);
  const listOriginal = { query: "list:1878727153048777016", list_since_id: "123" };
  const listParsed = parseTaskPayload("search", listOriginal);
  assert.equal(isXActionsEligible("search", listParsed, JSON.stringify(listOriginal)), false);
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
      RateLimitError: class RateLimitError extends Error {
        constructor(_message: string, options?: { resetAt?: number; status?: number }) {
          super("upstream rate limit reached");
          this.name = "RateLimitError";
          Object.assign(this, options);
        }
      },
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
  const onResponse = opts.onResponse as (result: { status: number; remaining: number | null; resetAt: number | null }) => void;
  onResponse({ status: 200, remaining: 0, resetAt: Date.now() + 60_000 });
  // Quota reset blocks a new network request before the user callback runs;
  // this regression test performs no socket connection.
  await assert.rejects(
    (opts.fetch as typeof fetch)("https://x.com/i/api/graphql/test/UserTweets"),
    (error: unknown) => error instanceof Error && error.name === "RateLimitError",
  );
});

test("members task accepts only a numeric list ID and bounded requested limit", () => {
  const payload = MembersPayload.parse({ list_id: "953048248406519809", limit: 75 });
  assert.equal(payload.list_id, "953048248406519809");
  assert.equal(payload.limit, 75);
  assert.throws(() => parseTaskPayload("members", { list_id: "bad-list" }));
  assert.throws(() => parseTaskPayload("members", { list_id: "953048248406519809", limit: 5000 }));
});
