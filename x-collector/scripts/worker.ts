import http from "node:http";
import { randomUUID } from "node:crypto";
import { claimTasks, deferTask } from "../lib/trade/tasks";
import { WorkerRegistry, reapDeadWorkers } from "../lib/trade/worker-registry";
import { checkDatabase, closePool, AmbiguousCommitError } from "../lib/trade/pg";
import { isRetryablePgError, pgErrorCode } from "../lib/trade/retry";
import { waitForDatabaseRecovery } from "../src/runtime/db-recovery";
import { log, withContext, closeLogger } from "../lib/trade/logger";
import { registry as promRegistry, startMetricsCollector, httpRequests, httpRequestDuration } from "../lib/trade/metrics";
import { getConfig } from "../lib/trade/config";
import { checkBasicAuth, isLoopbackHost } from "../lib/trade/http-auth";
import { applySecurityHeaders, clientIp, createRateLimiter } from "../lib/trade/http-security";
import { WorkerRuntime } from "../src/runtime/worker-runtime";
import { executeTask } from "../src/runtime/collector-task";
import { assertXActionsRuntime } from "../src/xactions/runtime";
import { setTimeout as delay } from "node:timers/promises";
const workerId = `${(process.env.WORKER_ID || "w").slice(0, 100)}-${randomUUID()}`;
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
const runtime = new WorkerRuntime(workerId);
const shutdownMs = Number(process.env.WORKER_SHUTDOWN_MS ?? 30000);
if (!Number.isInteger(shutdownMs) || shutdownMs < 1000 || shutdownMs > 300000) throw new Error("Invalid WORKER_SHUTDOWN_MS");
let shutdownTimer: NodeJS.Timeout | undefined;
function requestStop(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true; runtime.requestStop(); cancellation.abort();
  log.warn("worker stopping", { signal });
  shutdownTimer = setTimeout(() => { log.error("worker shutdown deadline exceeded; task leases will recover"); closeLogger(); process.exit(1); }, shutdownMs);
  shutdownTimer.unref();
}
const allowMetricsRequest = createRateLimiter(Number(process.env.METRICS_RATE_LIMIT ?? 600));
// Новый X Collector (src/x) для search-задач; по умолчанию выключен —
// production-путь searchTweets не затрагивается.
const USE_X_COLLECTOR = process.env.X_COLLECTOR === "src";
 // XActions remains opt-in and does not replace the existing search engine.
 const USE_XACTIONS = process.env.COLLECTOR_ENGINE === "xactions";
 if (USE_XACTIONS) {
   assertXActionsRuntime();
   if (!process.env.XACTIONS_ROOT) throw new Error("XACTIONS_ROOT must be configured when COLLECTOR_ENGINE=xactions");
 }
let shuttingDown = false;
const cancellation=new AbortController();

process.on("SIGINT", () => requestStop("SIGINT"));
process.on("SIGTERM", () => requestStop("SIGTERM"));
// Node's Windows process.kill does not deliver POSIX signals to the child.
process.on("message", message => {
  if (typeof message === "object" && message !== null && "stop" in message && message.stop === true) requestStop("IPC");
});


async function recoverDatabase() {
  // Registration is an idempotent write; never replay a task transaction.
  await waitForDatabaseRecovery(() => registry.register(), cancellation.signal, {
    onRetry: ({ attempt, delayMs, error }) => {
      log.warn("database offline; retrying worker registration", {
        attempt, delayMs, code: pgErrorCode(error) ?? "CONNECTION_ERROR",
      });
    },
  });
}

async function loop() {
  try {
    await recoverDatabase();
  } catch (error) {
    // Graceful shutdown during the initial database outage is not fatal.
    if (!shuttingDown) throw error;
  }
  if (!shuttingDown) {
    registry.start();
    runtime.ready();
    process.send?.({ ready: true });
  }
  const stopMetrics = startMetricsCollector();
  log.info("worker started", { workerId, pid: process.pid });

  const reapTimer = setInterval(() => {
    reapDeadWorkers().catch((e) => log.warn("reap failed", { error: String(e) }));
  }, 120_000);

  while (!shuttingDown) {
    try {
      const tasks = await claimTasks(workerId, 1, getConfig().sessions.leaseMs);
      if (tasks.length === 0) {
        await delay(5000, undefined, { signal: cancellation.signal }).catch(() => {});
        continue;
      }
      for (const task of tasks) {
        if (shuttingDown) { await deferTask(task.id, workerId, 0, "worker shutdown", task.attempts); break; }
        await withContext(
          { taskId: task.id, workerId, mint: task.mint ?? undefined, handle: task.handle ?? undefined },
          async () => {
            const result = await runtime.runJob(task, job => executeTask(job, { workerId, registry, signal: cancellation.signal, isStopping: () => shuttingDown, useSourceCollector: USE_X_COLLECTOR, useXActions: USE_XACTIONS }));
            log.info("task result", { result });
          }
        ).catch((e) => log.error("task runner crashed", { error: String(e) }));
      }
    } catch (e) {
      runtime.degraded();
      log.error("loop error", { error: String(e) });
      if (isRetryablePgError(e) || e instanceof AmbiguousCommitError) {
        // Do not claim READY after a fixed sleep if PostgreSQL is still down.
        // Re-register only; claimed task leases recover via the existing queue.
        try {
          await recoverDatabase();
        } catch (recoveryError) {
          if (!shuttingDown) throw recoveryError;
        }
      } else {
        await delay(10000, undefined, { signal: cancellation.signal }).catch(() => {});
      }
      if (!shuttingDown) runtime.ready();
    }
  }

  clearInterval(reapTimer);
  stopMetrics();
  await runtime.stop();
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
  if (shutdownTimer) clearTimeout(shutdownTimer);
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
      await checkDatabase();
      res.setHeader("Content-Type", "application/json");
      const state = runtime.snapshot();
      res.statusCode = state.ready ? 200 : 503;
      res.end(JSON.stringify({ ok: state.ready, ...state }));
      finish(res.statusCode); return;
    }
    res.statusCode = 404; res.end(); finish(404);
  } catch (e) {
    // El detalle de la excepción va al log, no al cliente.
    log.error("health server request failed", { error: String(e) });
    const status = pathname === "/health" ? 503 : 500;
    res.statusCode = status;
    res.end(status === 503 ? "Service Unavailable" : "Internal Server Error");
    finish(status);
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
