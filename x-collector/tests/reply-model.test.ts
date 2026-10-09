import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Filters,
  Settings,
  filterTweet,
  sleeping,
  SourceInput,
  AccountInput,
  Tweet,
} from "../lib/reply/model";
import { parseProxy } from "../lib/reply/proxy";
import { cosine, validateReply } from "../lib/reply/llm";
import { seal, unseal } from "../lib/reply/secrets";
const now = Date.parse("2026-10-08T09:00:00Z");
const tweet: Tweet = {
  id: "1",
  text: "Market update",
  author_id: "9",
  username: "Trader",
  created_at: new Date(now - 2 * 60000).toISOString(),
  likes: 10,
  retweets: 3,
  followers: 200,
  is_reply: false,
  is_quote: false,
  is_retweet: false,
  images: [],
};
test("filters apply age/type/metrics/blacklists sequentially, fail closed on invalid date", () => {
  const f = Filters.parse({});
  assert.equal(filterTweet(tweet, f, [], now), null);
  assert.equal(
    filterTweet(
      { ...tweet, created_at: new Date(now - 30000).toISOString() },
      f,
      [],
      now,
    ),
    "age",
  );
  assert.equal(
    filterTweet({ ...tweet, created_at: "invalid" }, f, [], now),
    "age",
  );
  assert.equal(filterTweet({ ...tweet, is_reply: true }, f, [], now), "reply");
  assert.equal(
    filterTweet({ ...tweet, is_retweet: true }, f, [], now),
    "retweet",
  );
  assert.equal(
    filterTweet(
      { ...tweet, is_quote: true },
      Filters.parse({ skip_quotes: true }),
      [],
      now,
    ),
    "quote",
  );
  assert.equal(
    filterTweet(tweet, Filters.parse({ min_likes: 11 }), [], now),
    "metrics",
  );
  assert.equal(
    filterTweet(tweet, f, [{ type: "word", value: "MARKET" }], now),
    "word",
  );
  assert.equal(
    filterTweet(tweet, f, [{ type: "account", value: "@trader" }], now),
    "account",
  );
  assert.throws(() => Filters.parse({ min_age: 20, max_age: 10 }));
});
test("sleep wraps midnight, uses IANA timezone, supports disabled mode", () => {
  const settings = Settings.parse({});
  assert(sleeping(settings, "Europe/Moscow", new Date("2026-10-07T23:00:00Z")));
  assert(
    !sleeping(settings, "Europe/Moscow", new Date("2026-10-08T05:00:00Z")),
  );
  assert(
    sleeping(
      Settings.parse({ sleep_start: 22, sleep_end: 6 }),
      "UTC",
      new Date("2026-10-08T01:00:00Z"),
    ),
  );
  assert(
    !sleeping(
      Settings.parse({ sleep_enabled: false }),
      "UTC",
      new Date("2026-10-08T02:00:00Z"),
    ),
  );
  assert.throws(() => Settings.parse({ hourly_limit: 31 }));
  assert.throws(() => SourceInput.parse({ type: "list", value: "not-id" }));
  assert.throws(() =>
    AccountInput.parse({ auth_token: "cookie-value", ct0: "value" }),
  );
});
test("proxy formats, protocols, default ports and encoded credentials", () => {
  for (const value of [
    "user:pass@host:8080",
    "host:8080:user:pass",
    "http://user:pass@host:8080",
  ])
    assert.deepEqual(parseProxy(value), {
      server: "http://host:8080",
      username: "user",
      password: "pass",
    });
  assert.equal(parseProxy("socks5://host:1080").server, "socks5://host:1080");
  assert.equal(
    parseProxy("socks4://user:pass@host:1080").server,
    "socks4://host:1080",
  );
  assert.equal(parseProxy("https://host:443").server, "https://host:443");
  assert.equal(parseProxy("http://host:80").server, "http://host:80");
  assert.equal(parseProxy("http://user:p%40ss@host:8080").password, "p@ss");
  for (const value of [
    "ftp://host:123",
    "http://host",
    "host:99999",
    "http://host:0",
    "http://host:8080/path",
  ])
    assert.throws(() => parseProxy(value));
});
test("RAG similarity and X weighted-length validation", () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([0, 0], [0, 1]), -1);
  assert.equal(cosine([1], [1, 2]), -1);
  assert.equal(validateReply(" short reply "), "short reply");
  assert.throws(() => validateReply(""));
  assert.throws(() => validateReply("字".repeat(141)));
});
test("versioned encryption supports rotation and rejects tampering", () => {
  const previous = {
    keys: process.env.REPLY_ENCRYPTION_KEYS,
    active: process.env.REPLY_ACTIVE_KEY_ID,
  };
  try {
    process.env.REPLY_ENCRYPTION_KEYS = JSON.stringify({
      old: "ab".repeat(32),
      next: "cd".repeat(32),
    });
    process.env.REPLY_ACTIVE_KEY_ID = "old";
    const original = seal({ access_token: "fixture-secret" });
    assert(original.startsWith("aesgcm:v1:old:"));
    assert.deepEqual(unseal(original), { access_token: "fixture-secret" });
    process.env.REPLY_ACTIVE_KEY_ID = "next";
    const rotated = seal(unseal(original));
    assert(rotated.startsWith("aesgcm:v1:next:"));
    assert.deepEqual(unseal(rotated), unseal(original));
    assert.throws(() => unseal(original.replace(":old:", ":next:")));
    assert.throws(() => unseal(original.slice(0, -4) + "AAAA"));
  } finally {
    if (previous.keys === undefined) delete process.env.REPLY_ENCRYPTION_KEYS;
    else process.env.REPLY_ENCRYPTION_KEYS = previous.keys;
    if (previous.active === undefined) delete process.env.REPLY_ACTIVE_KEY_ID;
    else process.env.REPLY_ACTIVE_KEY_ID = previous.active;
  }
});
