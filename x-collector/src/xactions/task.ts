import type { XAccount } from "../../lib/trade/account-manager";
import type { ClaimedTask } from "../../lib/trade/tasks";
import type { ScrapeAuthState } from "../../lib/trade/twitter-scraper";
import { persistProfile } from "../../lib/trade/collector-store";
import { listId } from "../../lib/trade/list-source";
import { parseProxy } from "../x/proxy";
import type { Progress } from "../../lib/collector/live";
import { createXActionsRuntime } from "./runtime";
import { createHttpQuotaGate, reserveAdditionalHttpRequest } from "./account-http-quota";
import { httpQueryFingerprint, loadHttpCheckpoint, type HttpCheckpointKey, type HttpLease } from "./checkpoint-store";
import { runCursorPages } from "./pagination";
import { persistXActionsTweetPage } from "./persist";
import { persistXActionsMemberPage } from "./persist-members";

type Parsed = { handle?: string; limit?: number; query?: string; list_id?: string; [key: string]: unknown };

export function isXActionsEligible(kind: string, payload: Parsed): boolean {
  if (kind === "profile" || kind === "timeline") return true;
  if (kind === "members") return typeof payload.list_id === "string" && /^[0-9]{1,25}$/.test(payload.list_id);
  if (kind !== "search" || typeof payload.query !== "string" || !listId(payload.query)) return false;
  // Existing historical/list-discovery book-keeping is still browser-only.
  return !(
    payload.history_run_id || payload.history_author || payload.history_since || payload.history_until ||
    payload.history_max_id || payload.discovery_source || payload.list_source_id ||
    payload.list_since_id || payload.list_max_id
  );
}

export interface XActionsTaskContext {
  task: ClaimedTask;
  payload: Parsed;
  account: XAccount;
  authState: ScrapeAuthState;
  leaseOwner: string;
  workerId: string;
  signal: AbortSignal;
  publish: (progress: Progress) => Promise<void>;
}

export async function executeXActionsReadTask(ctx: XActionsTaskContext): Promise<void> {
  const { task, payload, account, authState, leaseOwner, workerId, signal, publish } = ctx;
  if (!isXActionsEligible(task.kind, payload)) throw new Error("XActions: task is not eligible for HTTP");
  const accountKind = task.kind === "search" ? "search" : task.kind === "timeline" ? "timeline" : "profile";
  const charge = createHttpQuotaGate(accountKind,
    () => reserveAdditionalHttpRequest(account.name, leaseOwner));
  const lease: HttpLease = {
    workerId, attempt: task.attempts,
    accountName: account.name, accountOwner: leaseOwner,
  };
  const engine = await createXActionsRuntime({
    state: authState,
    proxy: parseProxy(account.proxy_json),
    userAgent: account.user_agent ?? undefined,
    signal, beforeRequest: charge,
  });

  if (task.kind === "profile") {
    const handle = String(payload.handle);
    signal.throwIfAborted();
    const profile = await engine.profile(handle);
    signal.throwIfAborted();
    await publish({ phase: "saving" });
    await persistProfile(profile, task.id, account.name, lease);
    return;
  }

  const sourceKind = task.kind === "timeline" ? "timeline" : task.kind === "members" ? "members" : "list";
  const sourceKey = sourceKind === "timeline" ? String(payload.handle).toLowerCase() :
    sourceKind === "members" ? String(payload.list_id) : listId(String(payload.query))!;
  const limit = Number(payload.limit);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("XActions: invalid task limit");
  // Each XActions GraphQL page requests 20 items. Finish pages, never discard
  // half of a page while moving the opaque cursor past unseen data.
  const totalPages = Math.ceil(limit / 20);
  const authorId = sourceKind === "timeline" ? await engine.resolveUserId(sourceKey) : null;
  const key: HttpCheckpointKey = {
    taskId: task.id, sourceKind, sourceKey,
    queryFingerprint: httpQueryFingerprint({ sourceKind, sourceKey, authorId, limit, graphQlCount: 20, version: "3.5.0" }),
  };
  const saved = await loadHttpCheckpoint(key);
  if (saved?.completed || (saved && saved.pagesCommitted >= totalPages)) return;
  let nextToFetch = saved?.cursor ?? null;
  const remaining = totalPages - (saved?.pagesCommitted ?? 0);
  let totalItems = saved?.itemsCommitted ?? 0;
  await runCursorPages(async (cursor) => {
    signal.throwIfAborted();
    return sourceKind === "timeline"
      ? engine.timelinePage(authorId!, cursor)
      : sourceKind === "members" ? engine.listMembersPage(sourceKey, cursor)
      : engine.listPage(sourceKey, cursor);
  }, async page => {
    signal.throwIfAborted();
    await publish({ phase: "saving" });
    if (sourceKind === "members") {
      await persistXActionsMemberPage({
        ...key, lease, previousCursor: nextToFetch,
      }, page as import("./pagination").PageCommit<import("../../lib/trade/twitter-scraper").AccountProfileData>);
    } else {
      await persistXActionsTweetPage({
        ...key, lease,
        mint: sourceKind === "list" ? task.mint : null,
        sourceQuery: sourceKind === "list" ? `list:${sourceKey}` : null,
        previousCursor: nextToFetch,
      }, page as import("./pagination").PageCommit<import("../../lib/trade/twitter-scraper").RawTweet>);
    }
    nextToFetch = page.nextCursor;
    totalItems += page.items.length;
    await publish({ phase: "collecting", found: totalItems, limit });
  }, { initialCursor: nextToFetch, maxPages: remaining, signal });
}
