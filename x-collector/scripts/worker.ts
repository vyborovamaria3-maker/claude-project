import http from "node:http";
import { randomUUID } from "node:crypto";
import { claimTasks, extendLease, finishTask, failTask, deferTask } from "../lib/trade/tasks";
import {
  pickAccount, recordSuccess, recordError, getAccountDelay,
  extendAccountLease, releaseAccount, XAccount,
} from "../lib/trade/account-manager";
import { WorkerRegistry, reapDeadWorkers } from "../lib/trade/worker-registry";
import { decryptBuffer } from "../lib/trade/crypto";
import { searchTweets, fetchUserTimeline, fetchAccountProfile, ScrapeAuthState } from "../lib/trade/twitter-scraper";
import { TweetSchema, ProfileSchema, parseTaskPayload } from "../lib/trade/schemas";
import { q, exec, closePool, tx } from "../lib/trade/pg";
import { log, withContext, closeLogger } from "../lib/trade/logger";
import {
  registry as promRegistry, tasksTotal, taskDuration, scrapeDuration,
  startMetricsCollector, httpRequests, httpRequestDuration,
} from "../lib/trade/metrics";
import { getConfig } from "../lib/trade/config";
import { checkBasicAuth, isLoopbackHost } from "../lib/trade/http-auth";
import { applySecurityHeaders, clientIp, createRateLimiter } from "../lib/trade/http-security";

const workerId = process.env.WORKER_ID || `w-${randomUUID().slice(0, 8)}`;
const METRICS_HOST = process.env.METRICS_HOST ?? "127.0.0.1";
const METRICS_PORT = Number(process.env.METRICS_PORT ?? 9091);
const METRICS_USER = process.env.METRICS_USER;
const METRICS_PASS = process.env.METRICS_PASS;
if (Boolean(METRICS_USER) !== Boolean(METRICS_PASS)) {
  throw new Error("METRICS_USER and METRICS_PASS must be set together");
}
if (!Number.isInteger(METRICS_PORT) || METRICS_PORT < 1 || METRICS_PORT > 65535) {
  throw new Error("METRICS_PORT must be an integer from 1 to 65535");
}
if (!isLoopbackHost(METRICS_HOST) && (!METRICS_USER || !METRICS_PASS)) {
  throw new Error("Metrics Basic Auth is required when binding to a non-loopback host");
}
const registry = new WorkerRegistry(workerId);
const allowMetricsRequest = createRateLimiter(Number(process.env.METRICS_RATE_LIMIT ?? 600));
let shuttingDown = false;

process.on("SIGINT", () => { log.warn("SIGINT — graceful shutdown"); shuttingDown = true; });
process.on("SIGTERM", () => { log.warn("SIGTERM — graceful shutdown"); shuttingDown = true; });

function buildProxy(acc: XAccount) {
  if (!acc.proxy_json) return undefined;
  try {
    const p = JSON.parse(acc.proxy_json);
    return p?.server ? p : undefined;
  } catch { return undefined; }
}

async function persistTweets(mint: string | null, tweets: unknown[], sourceQuery: string | null = null) {
  const valid: Array<ReturnType<typeof TweetSchema.parse>> = [];
  let rejected = 0;
  for (const raw of tweets) {
    const parsed = TweetSchema.safeParse(raw);
    if (parsed.success) valid.push(parsed.data);
    else rejected++;
  }
  if (rejected > 0) log.warn("tweets rejected by schema", { rejected });
  if (valid.length === 0) return;

  const now = Date.now();
  const BATCH = 200;

  for (let i = 0; i < valid.length; i += BATCH) {
    const chunk = valid.slice(i, i + BATCH);
    // Tweets y vínculos mint se insertan en una sola transacción: un fallo a mitad
    // no deja tweets sin su link (ni viceversa).
    await tx(async (client) => {
      const values: unknown[] = [];
      const placeholders = chunk.map((t, j) => {
        const off = j * 13;
        values.push(
          t.id, t.authorHandle.toLowerCase(), t.text, t.url,
          t.views, t.likes, t.retweets, t.replies,
          t.isVerified, t.postedAt, now, now, sourceQuery
        );
        return `($${off + 1},$${off + 2},$${off + 3},$${off + 4},$${off + 5},$${off + 6},$${off + 7},$${off + 8},$${off + 9},$${off + 10},$${off + 11},$${off + 12},$${off + 13})`;
      }).join(",");

      await client.query(
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

      if (mint) {
        const linkVals: unknown[] = [];
        const linkPh = chunk.map((t, j) => {
          const off = j * 4;
          linkVals.push(t.id, mint, t.authorHandle.toLowerCase(), now);
          return `($${off + 1},$${off + 2},$${off + 3},$${off + 4})`;
        }).join(",");
        await client.query(
          `INSERT INTO tweet_token_links (tweet_id, mint, handle, linked_at)
           VALUES ${linkPh} ON CONFLICT (tweet_id, mint) DO NOTHING`,
          linkVals
        );
      }
    });
  }
}

async function persistProfile(p: unknown) {
  const parsed = ProfileSchema.safeParse(p);
  if (!parsed.success) {
    log.warn("profile rejected by schema", { error: parsed.error.message });
    return;
  }
  const d = parsed.data;
  const now = Date.now();
  await exec(
    `INSERT INTO twitter_profiles
       (handle, display_name, bio, followers, following, posts_count, is_verified, joined_at, avatar_url, first_seen_at, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
     ON CONFLICT (handle) DO UPDATE SET
       display_name = COALESCE(EXCLUDED.display_name, twitter_profiles.display_name),
       bio          = COALESCE(EXCLUDED.bio, twitter_profiles.bio),
       followers    = COALESCE(EXCLUDED.followers, twitter_profiles.followers),
       following    = COALESCE(EXCLUDED.following, twitter_profiles.following),
       posts_count  = COALESCE(EXCLUDED.posts_count, twitter_profiles.posts_count),
       is_verified  = EXCLUDED.is_verified OR twitter_profiles.is_verified,
       joined_at    = COALESCE(EXCLUDED.joined_at, twitter_profiles.joined_at),
       avatar_url   = COALESCE(EXCLUDED.avatar_url, twitter_profiles.avatar_url),
       last_seen_at = EXCLUDED.last_seen_at`,
    [d.handle.toLowerCase(), d.displayName, d.bio, d.followers, d.following, d.postsCount,
     d.isVerified, d.joinedAt, d.avatarUrl, now]
  );
}

async function executeTask(task: Awaited<ReturnType<typeof claimTasks>>[number]): Promise<string> {
  const cfg = getConfig();

  let payload: ReturnType<typeof parseTaskPayload>;
  try {
    payload = parseTaskPayload(task.kind, task.payloadJson);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await failTask(task.id, workerId, `schema: ${msg}`).catch(() => {});
    return "invalid-payload";
  }

  const accountLeaseOwner = `${workerId.slice(0, 150)}:${task.id}:${randomUUID().slice(0, 8)}`;
  let account: XAccount | null;
  try {
    account = await pickAccount(task.kind === "search" ? "search"
      : task.kind === "timeline" ? "timeline" : "profile", accountLeaseOwner);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await failTask(task.id, workerId, `pickAccount: ${msg}`).catch(() => {});
    return "pick-failed";
  }

  if (!account) {
    await deferTask(task.id, workerId, 60_000, "no available account").catch(() => false);
    return "no-account";
  }
  const acc: XAccount = account;

  const startMs = Date.now();
  const kind = task.kind;

  let leaseLost: "task" | "account" | null = null;
  const assertLeases = () => {
    if (leaseLost) throw new Error(`${leaseLost} lease lost`);
  };
  const leaseTimer = setInterval(() => {
    extendLease(task.id, workerId, cfg.sessions.leaseMs)
      .then((ok) => { if (!ok) { leaseLost = "task"; log.warn("task lease lost", { taskId: task.id }); } })
      .catch((e) => { leaseLost = "task"; log.warn("extend task lease failed", { taskId: task.id, error: String(e) }); });
    extendAccountLease(acc.name, accountLeaseOwner, cfg.sessions.leaseMs)
      .then((ok) => { if (!ok) { leaseLost = "account"; log.warn("account lease lost", { account: acc.name }); } })
      .catch((e) => { leaseLost = "account"; log.warn("extend account lease failed", { account: acc.name, error: String(e) }); });
  }, Math.floor(cfg.sessions.leaseMs / 2));

  try {
    const decryptedSession = decryptBuffer(acc.session_encrypted);
    let authState: ScrapeAuthState | undefined;
    try {
      authState = JSON.parse(decryptedSession.toString("utf8")) as ScrapeAuthState;
      if (!authState || !Array.isArray(authState.cookies)) {
        throw new Error("invalid encrypted browser storage state");
      }
      const scrapeOpts = {
        authState,
        proxy: buildProxy(acc),
        userAgent: acc.user_agent ?? undefined,
        timezone: acc.timezone ?? undefined,
        headless: cfg.twitter.headless,
      };

      if (kind === "search") {
        const p = payload as { query: string; limit: number; sort: "top" | "latest" };
        const t0 = Date.now();
        const tweets = await searchTweets(p.query, { ...scrapeOpts, limit: p.limit, sort: p.sort });
        scrapeDuration.observe({ kind }, (Date.now() - t0) / 1000);
        assertLeases();
        await persistTweets(task.mint, tweets, p.query);
        assertLeases();
      } else if (kind === "timeline") {
        const p = payload as { handle: string; limit: number };
        const t0 = Date.now();
        const tweets = await fetchUserTimeline(p.handle, { ...scrapeOpts, limit: p.limit });
        scrapeDuration.observe({ kind }, (Date.now() - t0) / 1000);
        assertLeases();
        // A timeline task is scheduled because the author once mentioned a mint;
        // that does not make every post in the author's timeline about that mint.
        await persistTweets(null, tweets);
        assertLeases();
      } else {
        const p = payload as { handle: string };
        const t0 = Date.now();
        const profile = await fetchAccountProfile(p.handle, scrapeOpts);
        scrapeDuration.observe({ kind }, (Date.now() - t0) / 1000);
        assertLeases();
        await persistProfile(profile);
        assertLeases();
      }
    } finally {
      decryptedSession.fill(0);
      authState = undefined;
    }

    assertLeases();
    await recordSuccess(acc.name);
    assertLeases();
    const ok = await finishTask(task.id, workerId);
    if (!ok) {
      leaseLost = "task";
      throw new Error("task lease lost before completion");
    }
    registry.incrementDone();
    tasksTotal.inc({ kind, result: "done" });
    taskDuration.observe({ kind }, (Date.now() - startMs) / 1000);
    return "done";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    let kindErr: "rate_limit" | "captcha" | "ban" | "other" = "other";
    if (/rate limit|429|temporarily limited/i.test(msg)) kindErr = "rate_limit";
    else if (/captcha/i.test(msg)) kindErr = "captcha";
    else if (/login required|auth session expired/i.test(msg)) kindErr = "ban";

    if (!leaseLost) await recordError(acc.name, kindErr).catch(() => {});
    const result = await failTask(task.id, workerId, msg).catch(() => "lost" as const);
    if (result === "dlq") tasksTotal.inc({ kind, result: "dlq" });
    else if (result === "requeued") tasksTotal.inc({ kind, result: "retry" });
    registry.incrementFailed();
    log.warn("task failed", { taskId: task.id, error: msg, classification: kindErr, result });
    return "failed";
  } finally {
    clearInterval(leaseTimer);
    const delay = getAccountDelay(acc.tier);
    await releaseAccount(acc.name, accountLeaseOwner, delay).then((released) => {
      if (!released) log.warn("account release skipped; lease is no longer owned", { account: acc.name });
    }).catch((e) => log.warn("account release failed", { account: acc.name, error: String(e) }));
  }
}

async function loop() {
  await registry.register();
  registry.start();
  const stopMetrics = startMetricsCollector();
  log.info("worker started", { workerId, pid: process.pid });

  const reapTimer = setInterval(() => {
    reapDeadWorkers().catch((e) => log.warn("reap failed", { error: String(e) }));
  }, 120_000);

  while (!shuttingDown) {
    try {
      const tasks = await claimTasks(workerId, 1, getConfig().sessions.leaseMs);
      if (tasks.length === 0) {
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      for (const task of tasks) {
        if (shuttingDown) break;
        await withContext(
          { taskId: task.id, workerId, mint: task.mint ?? undefined, handle: task.handle ?? undefined },
          async () => {
            const result = await executeTask(task);
            log.info("task result", { result });
          }
        ).catch((e) => log.error("task runner crashed", { error: String(e) }));
      }
    } catch (e) {
      log.error("loop error", { error: String(e) });
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }

  clearInterval(reapTimer);
  stopMetrics();
  await registry.stop();
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    healthServer.close(finish);
    setTimeout(finish, 5000);
  });
  await closePool();
  log.info("worker stopped", { workerId });
  closeLogger();
  process.exit(0);
}

const healthServer = http.createServer(async (req, res) => {
  const start = Date.now();
  const pathname = (() => {
    try { return new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname; }
    catch { return "/invalid"; }
  })();
  const finish = (status: number) => {
    httpRequests.inc({ service: "worker", route: pathname, status: String(status) });
    httpRequestDuration.observe({ service: "worker", route: pathname }, (Date.now() - start) / 1000);
  };

  applySecurityHeaders(res);

  try {
    if (!allowMetricsRequest(clientIp(req))) {
      res.statusCode = 429; res.setHeader("Retry-After", "60"); res.end("Too Many Requests");
      finish(429); return;
    }
    if (METRICS_USER && METRICS_PASS) {
      const auth = req.headers.authorization;
      if (checkBasicAuth(typeof auth === "string" ? auth : undefined, METRICS_USER, METRICS_PASS) !== "ok") {
        res.setHeader("WWW-Authenticate", 'Basic realm="worker-metrics"');
        res.statusCode = 401; res.end("Unauthorized"); finish(401); return;
      }
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.statusCode = 405; res.setHeader("Allow", "GET, HEAD"); res.end(); finish(405); return;
    }
    if (pathname === "/metrics") {
      res.setHeader("Content-Type", promRegistry.contentType);
      res.end(await promRegistry.metrics());
      finish(200); return;
    }
    if (pathname === "/health") {
      await q(`SELECT 1`);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, workerId }));
      finish(200); return;
    }
    res.statusCode = 404; res.end(); finish(404);
  } catch (e) {
    // El detalle de la excepción va al log, no al cliente.
    log.error("health server request failed", { error: String(e) });
    res.statusCode = 500; res.end("Internal Server Error"); finish(500);
  }
});
healthServer.on("error", (e) => log.error("health server error", { error: String(e) }));
healthServer.listen(METRICS_PORT, METRICS_HOST, () =>
  log.info("health listening", { host: METRICS_HOST, port: METRICS_PORT, authenticated: Boolean(METRICS_USER && METRICS_PASS) })
);

loop().catch((e) => {
  log.error("fatal", { error: String(e) });
  process.exit(1);
});
