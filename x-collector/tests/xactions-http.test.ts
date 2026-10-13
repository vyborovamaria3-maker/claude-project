import assert from "node:assert/strict";
import test from "node:test";
import { normalizeXActionsProfile, normalizeXActionsTweet } from "../src/xactions/normalize";
import { runCursorPages, type PageCommit } from "../src/xactions/pagination";
import { toCollectorError } from "../src/xactions/errors";
import { CollectorHttpError } from "../lib/trade/task-errors";
import { createSocks5Fetch, socksProxyUrl } from "../src/xactions/transport";

const tweetId = "1878727153048777016";

test("XActions tweet normalization preserves IDs and does not invent missing metrics", () => {
  const item = normalizeXActionsTweet({
    id: tweetId, text: "hello", createdAt: "2026-10-12T12:00:00.000Z",
    author: { username: "NASA", name: "NASA", verified: true },
    metrics: { views: 0, likes: 20, retweets: 0, replies: 3 },
    urls: [{ url: "https://t.co/test", expandedUrl: "https://example.com/" }],
    mentions: [{ username: "NASA" }], hashtags: ["space"],
    media: [{ type: "animated_gif", url: "https://pbs.twimg.com/a.jpg", videoUrl: "https://video.twimg.com/a.mp4" }],
  }, 1234);
  assert.equal(item.id, tweetId);
  assert.equal(item.authorHandle, "NASA");
  assert.equal(item.views, null);
  assert.equal(item.likes, 20);
  assert.equal(item.retweets, null);
  assert.equal(item.replies, 3);
  assert.equal(item.observedAt, 1234);
  assert.deepEqual(item.links, ["https://example.com/"]);
  assert.deepEqual(item.media, [{ type: "video", url: "https://video.twimg.com/a.mp4" }]);
});

test("XActions profile normalization is conservative about unknown counters", () => {
  const p = normalizeXActionsProfile({ username: "NASA", name: "NASA", followers: 100, following: 0, tweets: 0 });
  assert.equal(p.handle, "NASA");
  assert.equal(p.followers, 100);
  assert.equal(p.following, null);
  assert.equal(p.postsCount, null);
  assert.equal(p.joinedAt, null);
  assert.throws(() => normalizeXActionsProfile({ username: "invalid/profile" }), /invalid author handle/);
});

test("cursor runner resumes from the saved cursor and commits each complete page", async () => {
  const requests: Array<string | null> = [];
  const committed: Array<PageCommit<string>> = [];
  const result = await runCursorPages(async cursor => {
    requests.push(cursor);
    return cursor === "saved" ? { items: ["a"], nextCursor: "next" } : { items: ["b"], nextCursor: null };
  }, async page => { committed.push(page); }, { initialCursor: "saved", maxPages: 5 });
  assert.deepEqual(requests, ["saved", "next"]);
  assert.deepEqual(committed.map(c => [c.pageNumber, c.nextCursor, c.completed]), [[1, "next", false], [2, null, true]]);
  assert.equal(result.itemsCommitted, 2);
  assert.equal(result.completed, true);
});

test("failed page persistence never advances in-memory cursor or fetches following page", async () => {
  const requests: Array<string | null> = [];
  await assert.rejects(runCursorPages(async cursor => {
    requests.push(cursor);
    return { items: ["one"], nextCursor: "new" };
  }, async () => { throw new Error("transaction rollback"); }, { initialCursor: "old", maxPages: 3 }), /transaction rollback/);
  assert.deepEqual(requests, ["old"]);
});

test("cursor runner rejects a non-advancing cursor", async () => {
  let writes = 0;
  await assert.rejects(runCursorPages(async () => ({ items: ["dup"], nextCursor: "same" }),
    async () => { writes++; }, { initialCursor: "same", maxPages: 3 }), /did not advance/);
  assert.equal(writes, 0);
});

test("XActions HTTP rate-limit errors use the collector's existing classifier", () => {
  const raw = Object.assign(new Error("rate limited"), { name: "RateLimitError", resetAt: Date.now() + 3000 });
  const mapped = toCollectorError(raw);
  assert.ok(mapped instanceof CollectorHttpError);
  assert.equal(mapped.status, 429);
  assert.ok(mapped.retryAfterMs > 0);
});

test("SOCKS5 proxy is mandatory; credentials are encoded and never echoed", () => {
  const url = socksProxyUrl({ server: "socks5://127.0.0.1:9050", username: "test@user", password: "pass#word" });
  assert.equal(url.username, "test%40user");
  assert.equal(url.password, "pass%23word");
  assert.throws(() => createSocks5Fetch({ server: "http://127.0.0.1:8080" }), /explicit SOCKS5/);
  assert.equal(typeof createSocks5Fetch({ server: "socks5://127.0.0.1:9050" }), "function");
});
