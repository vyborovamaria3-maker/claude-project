import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { parseProxy } from "../../x/proxy";
import { recordAccountError } from "../../accounts/errors";
import { recordProgress, Progress } from "../monitoring/live";
import { persistTweets, persistProfile } from "../persistence/collector-store";
import { claimTasks, extendLease, finishTask, failTask, deferTask } from "../queue/tasks";
import { pickAccount, accountWaitMs, recordSuccess, recordError, cooldownAccountProxy, getAccountDelay, extendAccountLease, releaseAccount, releaseUnconfirmedAccountReservation, WEIGHTS, XAccount } from "../accounts/account-manager";
import { WorkerRegistry } from "./worker-registry";
import { decryptBuffer } from "../../../lib/trade/crypto";
import { searchTweets, fetchUserTimeline, fetchAccountProfile, ScrapeAuthState, RawTweet } from "../engines/browser";
import { parseTaskPayload } from "../../../lib/trade/schemas";
import { q, getPool, checkDatabase, AmbiguousCommitError } from "../../../lib/trade/pg";
import { isRetryablePgError } from "../../../lib/trade/retry";
import { waitForDatabaseRecovery } from "./db-recovery";
import { log } from "../../../lib/trade/logger";
import { tasksTotal, taskDuration, scrapeDuration } from "../../../lib/trade/metrics";
import { getConfig } from "../../../lib/trade/config";
import { handleSearchTask } from "../../x/task-handler";
import { normalizeTweets } from "../../x/normalize";
import { listId } from "../../../lib/trade/list-source";
import { filterHistory, persistHistory } from "../../../lib/trade/history-filter";
import { taskFailure } from "../../../lib/trade/task-errors";
import { executeXActionsReadTask, isXActionsEligible, HttpPartialProgressError } from "../../xactions/task";
import { HttpAccountQuotaError, HttpAccountLeaseError, httpQuotaWaitMs, createHttpQuotaGate, reserveAdditionalHttpRequest } from "../../xactions/account-http-quota";
import { HttpNoProgressError } from "../../xactions/pagination";
function buildProxy(acc: XAccount) {
  const proxy = parseProxy(acc.proxy_json);
  if (acc.proxy_json && !proxy) throw new Error("PROXY_FAILED: invalid account proxy");
  return proxy;
}

export async function executeTask(task: Awaited<ReturnType<typeof claimTasks>>[number], context: { workerId: string; registry: WorkerRegistry; signal: AbortSignal; isStopping: () => boolean; useSourceCollector: boolean; useXActions?: boolean }): Promise<string> {
  const { workerId, registry, signal, isStopping, useSourceCollector, useXActions = false } = context;
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
    await failTask(task.id, workerId, `schema: ${msg}`, task.attempts).catch(() => {});
    return "invalid-payload";
  }

  if (task.kind === "members" && !useXActions) {
    await deferTask(task.id, workerId, 60000, "ListMembers requires COLLECTOR_ENGINE=xactions", task.attempts);
    return "members-disabled";
  }
  const historical=payload as {history_run_id?:string;history_since?:string;history_until?:string;history_author?:string;history_max_id?:string};
  if(historical.history_run_id&&!(await q("SELECT 1 FROM xc_history_runs WHERE id=$1 AND status='running'",[historical.history_run_id])).length){
    await deferTask(task.id,workerId,60000,'Historical collection paused',task.attempts);return 'history-paused';
  }
  if ((payload as {discovery_source?:string}).discovery_source || (historical.history_run_id && !historical.history_author)) {
    const policy = (await q("SELECT to_regclass('xc_discovery_plan') AS present"))[0];
    if (policy?.present && ((payload as {discovery_source?:string}).discovery_source || (await q('SELECT 1 FROM xc_discovery_plan WHERE enabled AND history_run_id=$1',[historical.history_run_id])).length)) {
      const {readiness} = createRequire(__filename)('../../../scripts/discovery-core.cjs') as {readiness:(c:ReturnType<typeof getPool>)=>Promise<{ready:boolean}>};
      if (!(await readiness(getPool())).ready) {
        await deferTask(task.id,workerId,60000,'Waiting for three-list archive',task.attempts);return 'discovery-waiting';
      }
    }
  }
  const accountLeaseOwner = `${workerId.slice(0, 150)}:${task.id}:${randomUUID().slice(0, 8)}`;
  const useLegacyHttpSearch = useXActions && task.kind === "search" && process.env.X_SEARCH_HTTP_COMPAT === "true";
  const needsProxy = useLegacyHttpSearch || (useXActions && isXActionsEligible(task.kind, payload, task.payloadJson));
  let account: XAccount | null;
  try {
    account = await pickAccount(task.kind === "search" ? "search"
      : task.kind === "timeline" ? "timeline" : "profile", accountLeaseOwner, (payload as {account_name?:string}).account_name, (payload as {account_fallback?:boolean}).account_fallback === true, needsProxy);
  } catch (e) {
    if (e instanceof AmbiguousCommitError || isRetryablePgError(e)) {
      // Selection may have committed despite the connection failing. Resolve
      // that exact owner token before retrying the same job; do not consume
      // retries for infrastructure failures or leak a leased account.
      await waitForDatabaseRecovery(() => checkDatabase(), signal);
      await releaseUnconfirmedAccountReservation(
        accountLeaseOwner, WEIGHTS[task.kind === "timeline" ? "timeline" :
          task.kind === "search" ? "search" : "profile"],
      );
      throw e; // Worker defers the still-claimed task with its attempt fence.
    }
    const msg = e instanceof Error ? e.message : String(e);
    await failTask(task.id, workerId, `pickAccount: ${msg}`, task.attempts).catch(() => {});
    return "pick-failed";
  }

  if (!account) {
    await publish({phase:"waiting"}).catch(()=>{});
    const wait = await accountWaitMs(task.kind === 'timeline' ? 'timeline' : (task.kind === 'profile' || task.kind === 'members') ? 'profile' : 'search', (payload as {account_name?:string}).account_name, (payload as {account_fallback?:boolean}).account_fallback === true, needsProxy).catch(()=>60000);
    await deferTask(task.id, workerId, wait, "no available account; waiting for lease or quota", task.attempts).catch(() => false);
    return "no-account";
  }
  const acc: XAccount = account;

  const startMs = Date.now();
  const kind = task.kind;

  const leaseAbort = new AbortController();
  const operationSignal = AbortSignal.any([signal, leaseAbort.signal]);
  const persistenceLease = { workerId, attempt: task.attempts, accountName: acc.name, accountOwner: accountLeaseOwner };
  let leaseLost: "task" | "account" | null = null;
  const assertLeases = () => {
    operationSignal.throwIfAborted();
    if (leaseLost) throw new Error(`${leaseLost} lease lost`);
  };
  let renewing: Promise<void> | undefined;
  const leaseTimer = setInterval(() => {
    if (renewing || leaseLost || isStopping()) return;
    renewing = (async () => {
      try {
        if (!await extendLease(task.id, workerId, cfg.sessions.leaseMs, task.attempts)) leaseLost = "task";
        else if (!await extendAccountLease(acc.name, accountLeaseOwner, cfg.sessions.leaseMs)) leaseLost = "account";
      } catch { leaseLost = "task"; }
      if (leaseLost) leaseAbort.abort(new Error(`${leaseLost} lease lost`));
    })().finally(() => { renewing = undefined; });
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
        signal:operationSignal,
        onProgress:publish,
        onBatch:async(tweets:RawTweet[])=>{
          assertLeases();await publish({phase:"saving"});
          const query=kind==="search"?(payload as {query:string}).query:null;
          const listPayload=payload as {list_source_id?:string;discovery_source?:string;list_since_id?:string;list_max_id?:string};
          const selected=filterHistory(tweets,historical).filter(t=>!(listPayload.list_source_id||listPayload.discovery_source) || ((!listPayload.list_since_id || BigInt(t.id)>BigInt(listPayload.list_since_id)) && (!listPayload.list_max_id || BigInt(t.id)<=BigInt(listPayload.list_max_id))));
          await persistTweets(kind==="search"?task.mint:null,selected,listPayload.list_source_id?`list:${listPayload.list_source_id}`:query,task.id,acc.name,persistenceLease,
            useLegacyHttpSearch ? { transport: "http" } : {});
          if(historical.history_run_id)await persistHistory(historical.history_run_id,task.id);
          assertLeases();await publish({phase:"collecting"});
        },
        proxy: buildProxy(acc),
        userAgent: acc.user_agent ?? undefined,
        timezone: acc.timezone ?? undefined,
        language: acc.language ?? undefined,
        headless: cfg.twitter.headless,
        beforeHttpRequest: useXActions ? createHttpQuotaGate("search",
          weight => reserveAdditionalHttpRequest(acc.name, accountLeaseOwner, weight)) : undefined,
      };

      if (useXActions && isXActionsEligible(kind, payload, task.payloadJson)) {
        const t0 = Date.now();
        try { await executeXActionsReadTask({
          task, payload, account: acc, authState,
          leaseOwner: accountLeaseOwner, workerId,
          signal: operationSignal, publish,
          beforeRequest: kind === "search" ? scrapeOpts.beforeHttpRequest : undefined,
        }); } catch (error) {
          // A retired list operation may still have accessible indexed matches.
          // Share the same quota gate across both transports; no second free call.
          if (!useLegacyHttpSearch || taskFailure(error).code !== "ENDPOINT_UNAVAILABLE") throw error;
          const p = payload as { query: string; limit: number; sort: "top" | "latest" };
          log.warn("native list endpoint unavailable; reading indexed list search", { taskId: task.id });
          await searchTweets(p.query, { ...scrapeOpts, limit: p.limit, sort: p.sort });
        }
        scrapeDuration.observe({ kind }, (Date.now() - t0) / 1000);
        assertLeases();
      } else if (kind === "search") {
        const p = payload as { query: string; limit: number; sort: "top" | "latest" };
        const t0 = Date.now();
        if (useSourceCollector && !useLegacyHttpSearch && !listId(p.query) && p.sort === "latest" && !historical.history_run_id && !(payload as {list_source_id?:string}).list_source_id && !(payload as {discovery_source?:string}).discovery_source) {
          const tweets = await handleSearchTask(task, { getAccount: async () => acc, signal: operationSignal });
          assertLeases();
          await persistTweets(task.mint, normalizeTweets(tweets), p.query, task.id, acc.name, persistenceLease);
        } else await searchTweets(p.query, { ...scrapeOpts, limit: p.limit, sort: p.sort });
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
        await persistProfile(profile, task.id,acc.name,persistenceLease);
        assertLeases();
      }
    } finally {
      decryptedSession.fill(0);
      authState = undefined;
    }

    assertLeases();
    await publish({phase:"finishing"});
    await recordSuccess(acc.name, accountLeaseOwner);
    assertLeases();
    const ok = await finishTask(task.id, workerId, task.attempts);
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
    if (e instanceof HttpAccountLeaseError && !leaseLost && !isStopping()) {
      await publish({phase:"waiting"}).catch(() => {});
      const ok = await deferTask(task.id, workerId, 5000, "XActions account ownership lost", task.attempts).catch(() => false);
      return ok ? "lease-waiting" : "lost";
    }
    if (e instanceof HttpPartialProgressError && !leaseLost && !isStopping()) {
      await publish({phase:"waiting"}).catch(() => {});
      const ok = await deferTask(task.id, workerId, 2_000, "XActions partial page budget; durable cursor saved", task.attempts).catch(() => false);
      return ok ? "partial" : "lost";
    }
    if (e instanceof HttpAccountQuotaError && !leaseLost && !isStopping()) {
      await publish({phase:"waiting"}).catch(()=>{});
      const wait = await httpQuotaWaitMs(acc.name).catch(() => 60000);
      const ok = await deferTask(task.id, workerId, wait, "XActions account HTTP quota exhausted", task.attempts).catch(() => false);
      return ok ? "quota-waiting" : "failed";
    }
    await publish({phase:isStopping()?"waiting":"failed"}).catch(()=>{});
    let kindErr: "rate_limit" | "captcha" | "ban" | "auth_expired" | "other" = "other";
    const failure = taskFailure(e);
    if (["PROXY_CONNECT", "PROXY_AUTH", "PROXY_DNS"].includes(failure.code) && !leaseLost && !isStopping()) {
      await cooldownAccountProxy(acc.name, accountLeaseOwner, failure.retryAfterMs || 60_000)
        .catch(error => log.warn("proxy cooldown write failed", { account: acc.name, error: String(error) }));
    }
    if (failure.code === "RATE_LIMIT") kindErr = "rate_limit";
    else if (failure.code === "ACCESS_REQUIRED") kindErr = "captcha";
    else if (failure.code === "AUTH_EXPIRED") kindErr = "auth_expired";

    // A private/forbidden resource is a task permission issue, not evidence
    // of a broken authenticated session or a CAPTCHA challenge.
    if (!["ACCESS_DENIED", "ACCESS_UNVERIFIED", "ENDPOINT_UNAVAILABLE",
          "SEARCH_UNCONFIRMED", "SEARCH_PARSE_UNCONFIRMED",
          "TIMELINE_UNCONFIRMED", "TIMELINE_PARSE_UNCONFIRMED", "PAGE_END_UNVERIFIED", "BROWSER_END_UNVERIFIED", "PAGINATION_STALLED",
          "SOURCE_SHAPE_CHANGED", "PROXY_CONNECT", "PROXY_AUTH", "PROXY_DNS", "PROXY_CONFIG_INVALID",
          "COLLECTION_TIMEOUT", "HTTP_RESPONSE_INVALID", "NETWORK_IO_UNVERIFIED", "DB_COMMIT_UNCERTAIN"].includes(failure.code) &&
        !(e instanceof HttpNoProgressError) && !leaseLost && !isStopping()) {
      await recordAccountError(acc.name,e).catch(()=>{});
      await recordError(acc.name, kindErr, failure.retryAfterMs, accountLeaseOwner).catch(() => {});
    }
    const result = isStopping() ? await deferTask(task.id,workerId,5000,"worker shutdown",task.attempts).then(ok=>ok?"requeued" as const:"lost" as const) : await failTask(task.id, workerId, e, task.attempts).catch(() => "lost" as const);
    if (result === "dlq") tasksTotal.inc({ kind, result: "dlq" });
    else if (result === "requeued") tasksTotal.inc({ kind, result: "retry" });
    if(!isStopping())registry.incrementFailed();
    log.warn("task failed", { taskId: task.id, error: msg, classification: kindErr, result });
    return isStopping() ? "shutdown" : "failed";
  } finally {
    clearInterval(leaseTimer);
    await renewing;
    const delay = getAccountDelay(acc.tier);
    await releaseAccount(acc.name, accountLeaseOwner, delay).then((released) => {
      if (!released) log.warn("account release skipped; lease is no longer owned", { account: acc.name });
    }).catch((e) => log.warn("account release failed", { account: acc.name, error: String(e) }));
  }
}
