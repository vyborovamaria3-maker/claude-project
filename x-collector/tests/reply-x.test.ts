import assert from "node:assert/strict";
import { test } from "node:test";
import { XClient, XError, PublishUncertainError } from "../lib/reply/x-api";
import type { requestJSON } from "../lib/reply/proxy";

test("official X adapter publishes the reply payload and respects error/reset semantics", async () => {
  const seen: Array<{ url: URL; options: Parameters<typeof requestJSON>[1] }> =
    [];
  const transport: typeof requestJSON = async (url, options) => {
    seen.push({ url, options });
    return { status: 201, headers: {}, data: { data: { id: "900" } } };
  };
  const client = new XClient(
    { access_token: "fixture-user-token" },
    undefined,
    transport,
  );
  assert.equal(await client.publish("123", "reply text"), "900");
  assert.equal(seen[0].url.href, "https://api.x.com/2/tweets");
  assert.equal(seen[0].options?.method, "POST");
  assert.deepEqual(seen[0].options?.body, {
    text: "reply text",
    reply: { in_reply_to_tweet_id: "123" },
  });
  const limited = new XClient(
    { access_token: "fixture" },
    undefined,
    async () => ({
      status: 429,
      headers: { "x-rate-limit-reset": "2000000000" },
      data: {},
    }),
  );
  await assert.rejects(
    limited.publish("123", "text"),
    (e: unknown) =>
      e instanceof XError && e.status === 429 && e.retryAt === 2000000000000,
  );
  const broken = new XClient(
    { access_token: "fixture" },
    undefined,
    async () => {
      throw new Error("disconnect");
    },
  );
  await assert.rejects(broken.publish("123", "text"), PublishUncertainError);
  const serverError = new XClient(
    { access_token: "fixture" },
    undefined,
    async () => ({ status: 503, headers: {}, data: {} }),
  );
  await assert.rejects(
    serverError.publish("123", "text"),
    PublishUncertainError,
  );
});
test("search/list pagination, expansions and media normalize actual X response shape", async () => {
  let path = "";
  const transport: typeof requestJSON = async (url) => {
    path = url.href;
    return {
      status: 200,
      headers: {},
      data: {
        data: [
          {
            id: "123",
            text: "post",
            author_id: "4",
            created_at: "2026-10-08T00:00:00Z",
            public_metrics: { like_count: 7, repost_count: 2 },
            referenced_posts: [{ type: "quoted", id: "2" }],
            attachments: { media_keys: ["m"] },
          },
        ],
        includes: {
          users: [
            {
              id: "4",
              username: "author",
              public_metrics: { followers_count: 50 },
            },
          ],
          media: [
            {
              media_key: "m",
              type: "photo",
              url: "https://pbs.twimg.com/media/a.jpg",
            },
          ],
        },
        meta: { newest_id: "123", next_token: "page-two" },
      },
    };
  };
  const client = new XClient({ access_token: "fixture" }, undefined, transport);
  const result = await client.source(
    "search",
    "from:author",
    "100",
    "page-one",
  );
  const url = new URL(path);
  assert.equal(url.pathname, "/2/tweets/search/recent");
  assert.equal(url.searchParams.get("next_token"), "page-one");
  assert.equal(url.searchParams.get("since_id"), "100");
  assert.equal(url.searchParams.get("post.fields"), "created_at,public_metrics,attachments");
  assert.equal(result.nextToken, "page-two");
  assert.equal(result.tweets[0].followers, 50);
  assert.equal(result.tweets[0].retweets, 2);
  assert.equal(result.tweets[0].is_quote, true);
  assert.deepEqual(result.tweets[0].images, [
    "https://pbs.twimg.com/media/a.jpg",
  ]);
  await client.source("list", "55", "100", "page-one");
  assert.equal(new URL(path).pathname, "/2/lists/55/tweets");
  assert.equal(new URL(path).searchParams.get("pagination_token"), "page-one");
  assert.equal(new URL(path).searchParams.has("since_id"), false);
  const old = await client.source("list", "55", "200");
  assert.deepEqual(old.tweets, []);
  assert.equal(old.nextToken, undefined);
});
