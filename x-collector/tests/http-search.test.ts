import assert from "node:assert/strict";
import test from "node:test";
import { collectHttpSearch } from "../lib/trade/http-search";
import type { RawTweet } from "../lib/trade/twitter-scraper";
import { toCollectorError } from "../src/xactions/errors";
import { taskFailure } from "../lib/trade/task-errors";

const tweet = (id: string) => ({ id }) as RawTweet;
test("obsolete HTTP endpoints trigger bounded retry without session quarantine", () => {
  const error = Object.assign(new Error("query not found"), { status: 404 });
  assert.deepEqual(taskFailure(toCollectorError(error)), { code: "ENDPOINT_UNAVAILABLE", permanent: false, retryAfterMs: 120_000 });
});
test("HTTP historical search preserves query/sort, deduplicates and persists before advancing", async () => {
  const query = "from:NASA since:2025-01-01 until:2025-02-01 max_id:123";
  const calls: (string | null)[] = [];
  const batches: string[][] = [];
  const result = await collectHttpSearch({ async diagnosticSearchPage(q, sort, cursor) {
    assert.equal(q, query); assert.equal(sort, "latest");
    if (cursor) assert.deepEqual(batches, [["1", "2"]]);
    calls.push(cursor);
    return cursor ? { items: [tweet("2"), tweet("3"), tweet("4")], nextCursor: "next" }
      : { items: [tweet("1"), tweet("2")], nextCursor: "first" };
  } }, query, { limit: 3, sort: "latest", onBatch: async batch => { batches.push(batch.map(t => t.id)); } });
  assert.deepEqual(result.map(t => t.id), ["1", "2", "3"]);
  assert.deepEqual(calls, [null, "first"]);
  assert.deepEqual(batches, [["1", "2"], ["3"]]);
});

test("failed persistence never fetches another HTTP search page", async () => {
  let calls = 0;
  await assert.rejects(collectHttpSearch({ async diagnosticSearchPage() {
    calls++; return { items: [tweet("1")], nextCursor: "next" };
  } }, "solana", { limit: 10, sort: "latest", onBatch: async () => { throw Error("storage failed"); } }), /storage failed/);
  assert.equal(calls, 1);
});

test("empty cursor pages, repeated cursors and cancellation never claim completion", async () => {
  let calls = 0;
  await assert.rejects(collectHttpSearch({ async diagnosticSearchPage() {
    return { items: [], nextCursor: String(++calls) };
  } }, "solana", { limit: 10, sort: "latest" }), /progress/i);
  assert.equal(calls, 3);
  await assert.rejects(collectHttpSearch({ async diagnosticSearchPage() {
    return { items: [tweet("1")], nextCursor: "same" };
  } }, "solana", { limit: 10, sort: "latest" }), /progress/i);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(collectHttpSearch({ async diagnosticSearchPage() {
    throw Error("must not fetch");
  } }, "solana", { limit: 10, sort: "latest", signal: controller.signal }), { name: "AbortError" });
});

test("only verified end-of-feed allows an empty search to finish", async () => {
  assert.deepEqual(await collectHttpSearch({ async diagnosticSearchPage() {
    return { items: [], nextCursor: null };
  } }, "solana", { limit: 10, sort: "latest" }), []);
  await assert.rejects(collectHttpSearch({ async diagnosticSearchPage() {
    throw Error("unverified terminal response");
  } }, "solana", { limit: 10, sort: "latest" }), /unverified/);
});
