import test from "node:test";
import assert from "node:assert/strict";
import { backoffDelay, retry, isRetryablePgError } from "../lib/trade/retry";

test("retry replays only classified transient failures and returns the eventual value", async () => {
  let calls = 0;
  const delays: number[] = [];
  const value = await retry(async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error("serialization failure"), { code: "40001" });
    return "ok";
  }, {
    attempts: 4,
    baseDelayMs: 100,
    maxDelayMs: 500,
    shouldRetry: (error) => (error as { code?: string }).code === "40001",
    random: () => 0,
    sleep: async (ms) => { delays.push(ms); },
  });
  assert.equal(value, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [50, 100]);
});

test("retry does not replay a permanent error", async () => {
  let calls = 0;
  await assert.rejects(retry(async () => {
    calls++;
    throw Object.assign(new Error("bad request"), { code: "22023" });
  }, {
    attempts: 5, baseDelayMs: 10, maxDelayMs: 100,
    shouldRetry: (error) => (error as { code?: string }).code === "40001",
    random: () => 0, sleep: async () => {},
  }), /bad request/);
  assert.equal(calls, 1);
});

test("backoff is capped and jitter stays within the documented interval", () => {
  assert.equal(backoffDelay(1, 100, 500, () => 0), 50);
  assert.equal(backoffDelay(2, 100, 500, () => 1), 200);
  assert.equal(backoffDelay(10, 100, 500, () => 1), 500);
});

test("isRetryablePgError classifies serialization/deadlock/connection but not validation", () => {
  assert.equal(isRetryablePgError({ code: "40001" }), true);
  assert.equal(isRetryablePgError({ code: "40P01" }), true);
  assert.equal(isRetryablePgError(new Error("connection reset by peer")), true);
  assert.equal(isRetryablePgError({ code: "22023" }), false);
  assert.equal(isRetryablePgError(new Error("syntax error")), false);
});
