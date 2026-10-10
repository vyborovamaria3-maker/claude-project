import { parseProxy } from "../src/x/proxy";
import { recordAccountError } from "../src/accounts/errors";
import { recordProgress, Progress } from "../lib/collector/live";
import { persistTweets, persistProfile } from "../lib/trade/collector-store";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { claimTasks, extendLease, finishTask, failTask, deferTask } from "../lib/trade/tasks";
import {
  pickAccount, recordSuccess, recordError, getAccountDelay,
  extendAccountLease, releaseAccount, XAccount,
} from "../lib/trade/account-manager";
import { WorkerRegistry, reapDeadWorkers } from "../lib/trade/worker-registry";
import { decryptBuffer } from "../lib/trade/crypto";
import { searchTweets, fetchUserTimeline, fetchAccountProfile, ScrapeAuthState, RawTweet } from "../lib/trade/twitter-scraper";
import { parseTaskPayload } from "../lib/trade/schemas";
import { q, closePool } from "../lib/trade/pg";
import { log, withContext, closeLogger } from "../lib/trade/logger";
import {
  registry as promRegistry, tasksTotal, taskDuration, scrapeDuration,
  startMetricsCollector, httpRequests, httpRequestDuration,
} from "../lib/trade/metrics";
import { getConfig } from "../lib/trade/config";
import { checkBasicAuth, isLoopbackHost } from "../lib/trade/http-auth";
import { applySecurityHeaders, clientIp, createRateLimiter } from "../lib/trade/http-security";
import { handleSearchTask } from "../src/x/task-handler";
import { normalizeTweets } from "../src/x/normalize";
import { listId } from "../lib/trade/list-source";

const workerId = process.env.WORKER_ID || `w-${randomUUID().slice(0, 8)}`;
const METRICS_HOST = process.env.METRICS_HOST ?? "127.0.0.1";
const METRICS_PORT = Number(process.env.METRICS_PORT ?? 9091);
const METRICS_USER = process.env.METRICS_USER;
const METRICS_PASS = process.env.METRICS_PASS;
if (Boolean(METRICS_USER) !== Boolean(METRICS_PASS)) {
  throw new Error("METRICS_USER and METRICS_PASS must be set together");
}
if (!Number.isInteger(METRICS_PORT) || METRICS_PORT < 0 || METRICS_PORT > 65535) {
  throw new Error("METRICS_PORT must be an integer from 0 to 65535");
}
if (!isLoopbackHost(METRICS_HOST) && (!METRICS_USER || !METRICS_PASS)) {
  throw new Error("Metrics Basic Auth is required when binding to a non-loopback host");
}
const registry = new WorkerRegistry(workerId);
const allowMetricsRequest = createRateLimiter(Number(process.env.METRICS_RATE_LIMIT ?? 600));
// Новый X Collector (src/x) для search-задач; по умолчанию выключен —
// production-путь searchTweets не затрагивается.
const USE_X_COLLECTOR = process.env.X_COLLECTOR === "src";
let shuttingDown = false;
const cancellation=new AbortController();

process.on("SIGINT", () => { log.warn("SIGINT — graceful shutdown"); shuttingDown = true; cancellation.abort(); });
process.on("SIGTERM", () => { log.warn("SIGTERM — graceful shutdown"); shuttingDown = true; cancellation.abort(); });

function buildProxy(acc: XAccount) {
 const proxy=parseProxy(acc.proxy_json);
 if(acc.proxy_json&&!proxy)throw new Error("PROXY_FAILED: invalid account proxy");
 return proxy;
}

async function executeTask(task: Awaited<ReturnType<typeof claimTasks>>[number]): Promise<string> {
  const cfg = getConfig();
  let progress:Progress={phase:"selecting",found:0,startedAt:Date.now()};
  const publish=async(p:Progress)=>{progress={...progress,...p};if(!await recordProgress(task.id,workerId,task.attempts,progress))throw new Error("task lease lost during progress update");};
  await publish({phase:"selecting"});

  let payload: ReturnType<typeof parseTaskPayload>;
  try {
    payload = parseTaskPayload(task.kind, task.payloadJson);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await publish({phase:"failed"}).catch(()=>{});
    await failTask(task.id, workerId, `schema: ${msg}`).catch(() => {});
    return "invalid-payload";
  }

  // Ветка нового X Collector (src/x). Стоит до pickAccount: аккаунт, сессия и
  // прокси берутся внутри handleSearchTask, иначе единственная учётка была бы
  // занята воркером и getCollectorAccount не вернул бы её. Lease/retry/defer —
  // те же функции очереди, что и в основном пути.
  if (task.kind === "search" && USE_X_COLLECTOR && !listId((payload as {query:string}).query) && !(payload as {account_name?:string}).account_name) {
    const startMs = Date.now();
    const leaseMs = cfg.sessions.leaseMs;
    let branchLeaseLost = false;
    const leaseTimer = setInterval(() => {
      extendLease(task.id, workerId, leaseMs)
        .then((ok) => { if (!ok) { branchLeaseLost = true; log.warn("task lease lost", { taskId: task.id }); } })
        .catch((e) => { branchLeaseLost = true; log.warn("extend task lease failed", { taskId: task.id, error: String(e) }); });
    }, Math.floor(leaseMs / 2));
    try {
      if (branchLeaseLost) throw new Error("task lease lost");
      const t0 = Date.now();
      const tweets = await handleSearchTask(task);
      scrapeDuration.observe({ kind: "search" }, (Date.now() - t0) / 1000);
      if (branchLeaseLost) throw new Error("task lease lost");
      await persistTweets(task.mint, normalizeTweets(tweets), (payload as { query: string }).query);
      if (branchLeaseLost) throw new Error("task lease lost");
      const ok = await finishTask(task.id, workerId);
      if (!ok) throw new Error("task lease lost before completion");
      registry.incrementDone();
      tasksTotal.inc({ kind: "search", result: "done" });
      taskDuration.observe({ kind: "search" }, (Date.now() - startMs) / 1000);
      return "done";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no available collector account/i.test(msg)) {
        await deferTask(task.id, workerId, 60_000, "no available account").catch(() => false);
        return "no-account";
      }
      const result = await failTask(task.id, workerId, msg).catch(() => "lost" as const);
      if (result === "dlq") tasksTotal.inc({ kind: "search", result: "dlq" });
      else if (result === "requeued") tasksTotal.inc({ kind: "search", result: "retry" });
      registry.incrementFailed();
      log.warn("task failed", { taskId: task.id, error: msg, result, collector: "src" });
      return "failed";
    } finally {
      clearInterval(leaseTimer);
    }
  }

  const accountLeaseOwner = `${workerId.slice(0, 150)}:${task.id}:${randomUUID().slice(0, 8)}`;
  let account: XAccount | null;
  try {
    account = await pickAccount(task.kind === "search" ? "search"
      : task.kind === "timeline" ? "timeline" : "profile", accountLeaseOwner, (payload as {account_name?:string}).account_name);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await failTask(task.id, workerId, `pickAccount: ${msg}`).catch(() => {});
    return "pick-failed";
  }

  if (!account) {
    await publish({phase:"waiting"}).catch(()=>{});
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
    await publish({phase:"opening",account:acc.name});
    const decryptedSession = decryptBuffer(acc.session_encrypted);
    let authState: ScrapeAuthState | undefined;
    try {
      authState = JSON.parse(decryptedSession.toString("utf8")) as ScrapeAuthState;
      if (!authState || !Array.isArray(authState.cookies)) {
        throw new Error("invalid encrypted browser storage state");
      }
      const scrapeOpts = {
        authState,
        signal:cancellation.signal,
        onProgress:publish,
        onBatch:async(tweets:RawTweet[])=>{
          assertLeases();await publish({phase:"saving"});
          const query=kind==="search"?(payload as {query:string}).query:null;
          await persistTweets(kind==="search"?task.mint:null,tweets,query,task.id);
          assertLeases();await publish({phase:"collecting"});
        },
        proxy: buildProxy(acc),
        userAgent: acc.user_agent ?? undefined,
        timezone: acc.timezone ?? undefined,
        language: acc.language ?? undefined,
        headless: cfg.twitter.headless,
      };

      if (kind === "search") {
        const p = payload as { query: string; limit: number; sort: "top" | "latest" };
        const t0 = Date.now();
        await searchTweets(p.query, { ...scrapeOpts, limit: p.limit, sort: p.sort });
        scrapeDuration.observe({ kind }, (Date.now() - t0) / 1000);
        assertLeases();

      } else if (kind === "timeline") {
        const p = payload as { handle: string; limit: number };
        const t0 = Date.now();
        await fetchUserTimeline(p.handle, { ...scrapeOpts, limit: p.limit });
        scrapeDuration.observe({ kind }, (Date.now() - t0) / 1000);
        assertLeases();

      } else {
        const p = payload as { handle: string };
        const t0 = Date.now();
        const profile = await fetchAccountProfile(p.handle, scrapeOpts);
        scrapeDuration.observe({ kind }, (Date.now() - t0) / 1000);
        assertLeases();
        await publish({phase:"saving"});
        await persistProfile(profile, task.id);
        assertLeases();
      }
    } finally {
      decryptedSession.fill(0);
      authState = undefined;
    }

    assertLeases();
    await publish({phase:"finishing"});
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
    await publish({phase:shuttingDown?"waiting":"failed"}).catch(()=>{});
    let kindErr: "rate_limit" | "captcha" | "ban" | "other" = "other";
    if (/rate limit|429|temporarily limited/i.test(msg)) kindErr = "rate_limit";
    else if (/captcha/i.test(msg)) kindErr = "captcha";
    else if (/login required|auth session expired/i.test(msg)) kindErr = "ban";

    if (!leaseLost && !shuttingDown) await recordAccountError(acc.name,e).catch(()=>{});
    if (!leaseLost && !shuttingDown) await recordError(acc.name, kindErr).catch(() => {});
    const result = shuttingDown ? await deferTask(task.id,workerId,5000,"worker shutdown").then(ok=>ok?"requeued" as const:"lost" as const) : await failTask(task.id, workerId, msg).catch(() => "lost" as const);
    if (result === "dlq") tasksTotal.inc({ kind, result: "dlq" });
    else if (result === "requeued") tasksTotal.inc({ kind, result: "retry" });
    if(!shuttingDown)registry.incrementFailed();
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
  process.send?.({ ready: true });
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
