import assert from "node:assert/strict";
import { test } from "node:test";
import { waitForDatabaseRecovery } from "../src/runtime/db-recovery";
import { isRetryablePgError } from "../lib/trade/retry";
import { taskFailure } from "../lib/trade/task-errors";

test("database registration survives transient pool acquisition failures with bounded backoff", async () => {
  const attempts: number[] = [];
  const delays: number[] = [];
  let called = 0;
  await waitForDatabaseRecovery(async () => {
    called++;
    if (called <= 2) throw new Error("timeout exceeded when trying to connect");
  }, new AbortController().signal, {
    baseDelayMs: 100,
    maxDelayMs: 400,
    random: () => 0,
    sleep: async ms => { delays.push(ms); },
    onRetry: ({ attempt }) => { attempts.push(attempt); },
  });
  assert.equal(called, 3);
  assert.deepEqual(delays, [50, 100]);
  assert.deepEqual(attempts, [1, 2]);
});

test("database recovery rejects configuration and non-transient SQL errors", async () => {
  let attempts = 0;
  await assert.rejects(waitForDatabaseRecovery(async () => {
    attempts++;
    throw Object.assign(new Error("relation x_workers does not exist"), { code: "42P01" });
  }, new AbortController().signal, { sleep: async () => { throw new Error("unexpected retry"); } }), /does not exist/);
  assert.equal(attempts, 1);
  await assert.rejects(waitForDatabaseRecovery(async () => {}, new AbortController().signal,
    { baseDelayMs: 200, maxDelayMs: 100 }), /Invalid database recovery delays/);
});

test("database recovery stops immediately when the worker shuts down", async () => {
  const controller = new AbortController();
  let called = 0;
  await assert.rejects(waitForDatabaseRecovery(async () => {
    called++;
    throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
  }, controller.signal, {
    sleep: async () => { controller.abort(new Error("shutdown requested")); },
  }), /shutdown requested/);
  assert.equal(called, 1);
});

test("database retry classification covers pool/network outages but not statement timeouts", () => {
  for (const message of ["timeout exceeded when trying to connect", "Connection terminated unexpectedly",
    "connect EHOSTUNREACH 127.0.0.1", "write EPIPE"]) {
    assert.equal(isRetryablePgError(new Error(message)), true, message);
  }
  assert.equal(isRetryablePgError(new Error("canceling statement due to statement timeout")), false);
});

test("X scraping failures keep distinct diagnostic codes and do not imply empty results", () => {
  const cases: Array<[string, string]> = [
    ["search results did not load — no tweets and no empty state", "SEARCH_UNCONFIRMED"],
    ["XActions: ambiguous timeline end without terminal instruction", "PAGE_END_UNVERIFIED"],
    ["XACTIONS_NO_PROGRESS: repeated pages contain no new unique items", "PAGINATION_STALLED"],
    ["XActions: user timeline response shape changed", "SOURCE_SHAPE_CHANGED"],
    ["SOCKS5 proxy connection refused", "PROXY_CONNECT"],
    ["XActions: HTTP request timed out", "COLLECTION_TIMEOUT"],
  ];
  for (const [message, code] of cases) {
    const failure = taskFailure(new Error(message));
    assert.equal(failure.code, code, message);
    assert.equal(failure.permanent, false, message);
    assert(failure.retryAfterMs > 0, message);
  }
  assert.equal(taskFailure(new Error("schema: invalid payload")).permanent, true);
  assert.equal(taskFailure(new Error("rate limit 429")).code, "RATE_LIMIT");
});
