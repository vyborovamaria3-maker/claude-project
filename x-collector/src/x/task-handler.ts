import type { ClaimedTask } from "../../lib/trade/tasks";
import { parseTaskPayload } from "../../lib/trade/schemas";
import { decryptBuffer } from "../../lib/trade/crypto";
import { CollectorAccount } from "./account-session";
import { pickAccount, releaseAccount, extendAccountLease, recordSuccess, recordError, getAccountDelay } from "../../lib/trade/account-manager";
import { getConfig } from "../../lib/trade/config";
import { randomUUID } from "node:crypto";
import { taskFailure } from "../../lib/trade/task-errors";
import { parseProxy } from "./proxy";
import { extractCookies } from "./session";
import { searchX, SearchXOptions } from "./collector";
import type { XTweet } from "./types";

export interface SearchTaskDeps {
  getAccount?: () => Promise<CollectorAccount | null>;
  search?: (query: string, options: SearchXOptions) => Promise<XTweet[]>;
  signal?: AbortSignal;
}

/**
 * Адаптер search-задачи для нового X Collector:
 * keyword из payload → аккаунт из x_accounts → decrypt → proxy → searchX.
 * Standalone callers reserve an account. A worker may supply its already-owned account.
 */
export async function handleSearchTask(
  task: ClaimedTask,
  deps: SearchTaskDeps = {}
): Promise<XTweet[]> {
  const owner = `search-${randomUUID()}`;
  const getAccount = deps.getAccount ?? (() => pickAccount("search", owner));
  const search = deps.search ?? searchX;

  const payload = parseTaskPayload(task.kind, task.payloadJson) as { query: string; limit: number };

  const account = await getAccount();
  if (!account) throw new Error("no available collector account");

  const lease = new AbortController();
  const leaseMs = getConfig().sessions.leaseMs;
  const renewal = deps.getAccount ? undefined : setInterval(() => {
    void extendAccountLease(account.name, owner, leaseMs).then(ok => {
      if (!ok) lease.abort(new Error("account lease lost"));
    }).catch(() => lease.abort(new Error("account lease renewal failed")));
  }, Math.floor(leaseMs / 2));
  try {
  const decrypted = decryptBuffer(account.session_encrypted);
  let cookies: ReturnType<typeof extractCookies>;
  try {
    cookies = extractCookies(decrypted);
  } finally {
    decrypted.fill(0);
  }

  const proxy=parseProxy(account.proxy_json);
  if(account.proxy_json&&!proxy)throw new Error("PROXY_FAILED: invalid account proxy");
  const tweets = await search(payload.query, {
    cookies,
    proxy,
    userAgent: account.user_agent || undefined,
    timezone: account.timezone || undefined,
    language: account.language || undefined,
    limit: payload.limit,
    signal: deps.signal ? AbortSignal.any([deps.signal, lease.signal]) : lease.signal,
  });
  if (lease.signal.aborted || deps.signal?.aborted) throw new Error("collection cancelled");
  if (!deps.getAccount) await recordSuccess(account.name, owner);
  return tweets.slice(0, payload.limit);
  } catch (error) {
    if (!deps.getAccount && !lease.signal.aborted && !deps.signal?.aborted) {
      const failure = taskFailure(error);
      await recordError(account.name, failure.code === "RATE_LIMIT" ? "rate_limit"
        : failure.code === "AUTH_EXPIRED" ? "auth_expired"
        : failure.code === "ACCESS_REQUIRED" ? "captcha" : "other", failure.retryAfterMs, owner).catch(() => {});
    }
    throw error;
  } finally {
    if (renewal) clearInterval(renewal);
    if (!deps.getAccount) await releaseAccount(account.name, owner,
      getAccountDelay((account as { tier?: "new" | "warm" | "hot" | "retired" }).tier ?? "new"));
  }
}
