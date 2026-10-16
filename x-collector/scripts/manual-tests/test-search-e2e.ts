import { getCollectorAccount } from "../src/x/account-session";
import { handleSearchTask } from "../src/x/task-handler";
import { normalizeTweets } from "../src/x/normalize";
import { printDiagnostics } from "../src/x/diagnostics";
import { enqueueTask, claimTasks, finishTask, failTask, deferTask, ClaimedTask } from "../lib/trade/tasks";
import { q, q1, tx, closePool } from "../lib/trade/pg";

const WORKER_ID = "e2e-test";
// sort: SearchPayload допускает только top|latest («live» отклонился бы zod'ом);
// сам collector ходит по f=live.
const PAYLOAD = { query: "bitcoin", limit: 5, sort: "latest" as const };
const SEARCH_URL = `https://x.com/search?q=${encodeURIComponent(PAYLOAD.query)}&f=live`;

function httpStatusOf(msg: string): number {
  const m = /HTTP (\d{3})/.exec(msg);
  return m ? Number(m[1]) : 0;
}

function classify(msg: string): string {
  if (msg.startsWith("AUTH_REQUIRED")) return "AUTH_REQUIRED";
  if (msg.startsWith("X_BLOCKED")) return "X_BLOCKED";
  if (msg.startsWith("RATE_LIMIT")) return "RATE_LIMIT";
  if (msg.startsWith("EMPTY_RESULT")) return "EMPTY_RESULT";
  if (/no available collector account/.test(msg)) return "NO_ACCOUNT";
  return "OTHER";
}

async function persistTweetsLikeWorker(rows: ReturnType<typeof normalizeTweets>, sourceQuery: string): Promise<number> {
  if (rows.length === 0) return 0;
  const now = Date.now();
  let saved = 0;
  await tx(async (client) => {
    const values: unknown[] = [];
    const placeholders = rows.map((t, j) => {
      const off = j * 13;
      values.push(
        t.id, t.authorHandle.toLowerCase(), t.text, t.url,
        t.views, t.likes, t.retweets, t.replies,
        t.isVerified, t.postedAt, now, now, sourceQuery
      );
      return `($${off + 1},$${off + 2},$${off + 3},$${off + 4},$${off + 5},$${off + 6},$${off + 7},$${off + 8},$${off + 9},$${off + 10},$${off + 11},$${off + 12},$${off + 13})`;
    }).join(",");
    const r = await client.query(
      `INSERT INTO twitter_tweets
         (tweet_id, handle, text, url, views, likes, retweets, replies, is_verified, posted_at, first_seen_at, updated_at, source_query)
       VALUES ${placeholders}
       ON CONFLICT (tweet_id) DO UPDATE SET
         views    = GREATEST(twitter_tweets.views,    EXCLUDED.views),
         likes    = GREATEST(twitter_tweets.likes,    EXCLUDED.likes),
         retweets = GREATEST(twitter_tweets.retweets, EXCLUDED.retweets),
         replies  = GREATEST(twitter_tweets.replies,  EXCLUDED.replies),
         source_query = COALESCE(EXCLUDED.source_query, twitter_tweets.source_query),
         updated_at = EXCLUDED.updated_at
       WHERE EXCLUDED.updated_at > twitter_tweets.updated_at`,
      values
    );
    saved = r.rowCount ?? 0;
  });
  return saved;
}

async function main() {
  // 1. активный аккаунт
  const account = await getCollectorAccount();
  if (!account) {
    console.log("No active collector account");
    return;
  }
  console.log(`[e2e] account: ${account.name}`);

  const before = (await q1<{ n: number }>("SELECT count(*)::int AS n FROM twitter_tweets"))?.n ?? 0;
  console.log(`[e2e] twitter_tweets before: ${before}`);

  // 2. тестовая задача в существующей очереди
  const taskId = await enqueueTask({ kind: "search", payload: PAYLOAD, dedup: false });
  if (!taskId) throw new Error("enqueue failed");
  console.log(`[e2e] task #${taskId} enqueued (kind=search, query=${PAYLOAD.query}, limit=${PAYLOAD.limit})`);

  // claim: свои берём, чужие возвращаем в очередь (attempts компенсируется defer'ом)
  const claimed = await claimTasks(WORKER_ID, 50, 300_000);
  let task: ClaimedTask | undefined;
  for (const t of claimed) {
    if (t.id === taskId) task = t;
    else await deferTask(t.id, WORKER_ID, 0, "e2e: requeue foreign task").catch(() => false);
  }
  if (!task) throw new Error(`task #${taskId} not claimable`);

  // 3. реальный handler (x_accounts → decrypt → searchX, без mock)
  let tweets;
  try {
    tweets = await handleSearchTask(task);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await failTask(task.id, WORKER_ID, msg).catch(() => {});
    console.log(`[e2e] handler failed: ${msg}`);
    console.log(`[e2e] classification: ${classify(msg)}`);
    printDiagnostics({
      error: e,
      url: SEARCH_URL,
      httpStatus: httpStatusOf(msg),
      account: account.name,
      proxyJson: account.proxy_json,
    }, "[x-search-e2e]");
    throw e;
  }
  console.log(`[e2e] handler returned ${tweets.length} tweets`);

  // 4. сохранение (тот же INSERT, что persistTweets в worker) + finish
  const rows = normalizeTweets(tweets);
  const saved = await persistTweetsLikeWorker(rows, PAYLOAD.query);
  const finished = await finishTask(task.id, WORKER_ID);
  if (!finished) console.warn("[e2e] finishTask: lease уже потерян");

  const after = (await q1<{ n: number }>("SELECT count(*)::int AS n FROM twitter_tweets"))?.n ?? 0;
  const exampleRows = rows.length
    ? await q<Record<string, unknown>>("SELECT * FROM twitter_tweets WHERE tweet_id = ANY($1::text[]) LIMIT 1", [rows.map((r) => r.id)])
    : [];
  const example = exampleRows[0];

  console.log(`[e2e] collected: ${tweets.length}, normalized: ${rows.length}, insert-affected: ${saved}`);
  console.log(`[e2e] twitter_tweets after: ${after} (delta ${after - before})`);
  if (example) {
    console.log("[e2e] example saved tweet:");
    console.log(JSON.stringify(example, null, 2));
  }
  console.log("[e2e] supported errors: AUTH_REQUIRED | X_BLOCKED | RATE_LIMIT | EMPTY_RESULT | NO_ACCOUNT | OTHER");
}

main()
  .catch((e) => {
    console.error("[x-search-e2e] ошибка:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => {}));
