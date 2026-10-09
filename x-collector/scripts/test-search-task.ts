import assert from "node:assert/strict";
import { handleSearchTask, SearchTaskDeps } from "../src/x/task-handler";
import { normalizeTweet, normalizeTweets } from "../src/x/normalize";
import { TweetSchema } from "../lib/trade/schemas";
import { encryptBuffer } from "../lib/trade/crypto";
import { closePool } from "../lib/trade/pg";
import type { ClaimedTask } from "../lib/trade/tasks";
import type { CollectorAccount } from "../src/x/account-session";
import type { XTweet } from "../src/x/types";

const fakeTask: ClaimedTask = {
  id: 999001,
  kind: "search",
  payloadJson: JSON.stringify({ query: "bitcoin", limit: 2, sort: "latest" }),
  mint: null,
  handle: null,
  attempts: 1,
  maxAttempts: 3,
  claimedBy: "test-worker",
};

const fakeTweets: XTweet[] = [
  { id: "1234567890123456789", author: "satoshi", text: "bitcoin #1", url: "https://x.com/satoshi/status/1234567890123456789", likes: 1, reposts: 2, replies: 3, views: 4, createdAt: 1700000000000 },
  { id: "1234567890123456790", author: "hal", text: "bitcoin #2", url: "https://x.com/hal/status/1234567890123456790", likes: 5, reposts: 6, replies: 7, views: 8, createdAt: 1700000001000 },
  { id: "1234567890123456791", author: "nick", text: "bitcoin #3", url: "https://x.com/nick/status/1234567890123456791", likes: 9, reposts: 10, replies: 11, views: 12, createdAt: 1700000002000 },
];

const fakeAccount: CollectorAccount = {
  name: "test-acc",
  session_encrypted: encryptBuffer(Buffer.from(JSON.stringify({
    cookies: [{ name: "auth_token", value: "t", domain: ".x.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }],
  }), "utf8")),
  proxy_json: JSON.stringify({ host: "127.0.0.1", port: 8080 }),
  user_agent: null,
  timezone: null,
};

async function main() {
  // 1. handler вызывается: mock search получает keyword/cookies/options, лимит применяется
  let called = false;
  const deps: SearchTaskDeps = {
    getAccount: async () => fakeAccount,
    search: async (query, options) => {
      called = true;
      assert.equal(query, "bitcoin");
      assert.equal(options.cookies?.length, 1);
      assert.equal(options.cookies?.[0]?.name, "auth_token");
      assert.equal(options.proxy?.server, "http://127.0.0.1:8080");
      assert.equal(options.limit, 2);
      return fakeTweets;
    },
  };
  const tweets = await handleSearchTask(fakeTask, deps);
  assert.equal(called, true, "mock search must be called");
  assert.equal(tweets.length, 2, "limit from payload must be applied");
  console.log("OK: handler вызван, keyword/cookies/proxy/limit проверены");

  // 2. normalizeTweet попадает в существующую схему twitter_tweets
  const normalized = normalizeTweet(tweets[0]!);
  assert.ok(normalized, "valid tweet must not be skipped");
  const parsed = TweetSchema.safeParse(normalized);
  assert.equal(parsed.success, true, parsed.success ? "" : parsed.error.message);
  console.log("OK: normalizeTweet валиден по TweetSchema");
  console.log(JSON.stringify(normalized, null, 2));

  // 3. skip-правила normalize: пустой text / нет id → null, из списка исключаются
  assert.equal(normalizeTweet({ ...fakeTweets[0]!, text: "   " }), null);
  assert.equal(normalizeTweet({ ...fakeTweets[0]!, id: "" }), null);
  assert.equal(normalizeTweets([fakeTweets[0]!, { ...fakeTweets[1]!, id: "" }]).length, 1);
  console.log("OK: normalize skip (пустой text / нет id)");

  // 4. нет аккаунта → ошибка, которую worker обработает через deferTask
  await assert.rejects(
    handleSearchTask(fakeTask, { ...deps, getAccount: async () => null }),
    /no available collector account/
  );
  console.log("OK: no account → ошибка распознаётся как defer-кейс");

  // 5. ошибка X/сети пробрасывается наверх (worker сделает failTask/retry)
  await assert.rejects(
    handleSearchTask(fakeTask, { ...deps, search: async () => { throw new Error("boom"); } }),
    /boom/
  );
  console.log("OK: ошибка поиска пробрасывается на failTask");

  console.log("x:task:test passed");
}

main()
  .catch((e) => {
    console.error("[x-task-test] ошибка:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => {}));
