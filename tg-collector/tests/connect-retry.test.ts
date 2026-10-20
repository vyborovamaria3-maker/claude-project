import { test } from "node:test";
import assert from "node:assert/strict";
import { connectWithRetry } from "../src/runtime/connect-retry.js";

test("startup transport errors retry with bounded backoff", async () => {
  let count = 0;
  const pauses: number[] = [];
  const result = await connectWithRetry(async () => {
    count++;
    if (count < 3) throw new Error("read ECONNRESET");
    return "connected";
  }, {random: () => 0, pause: async (ms) => { pauses.push(ms); }});
  assert.equal(result, "connected");
  assert.equal(count, 3);
  assert.deepEqual(pauses, [1500, 3000]);
});

test("session revocation and Telegram FloodWait are never retried at startup", async () => {
  for (const message of ["SESSION_REVOKED", "FLOOD_WAIT_60", "Set TG_API_ID and TG_API_HASH in .env"]) {
    let count = 0;
    await assert.rejects(connectWithRetry(async () => {
      count++;
      throw new Error(message);
    }, {pause: async () => { throw new Error("Must not sleep"); }}), (error: unknown) =>
      error instanceof Error && error.message === message);
    assert.equal(count, 1);
  }
});
