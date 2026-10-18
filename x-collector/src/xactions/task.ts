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

/** A valid durable checkpoint needs another bounded pass, not a failed attempt. */
export class HttpPartialProgressError extends Error {
  constructor(readonly pagesCommitted: number, readonly uniqueItemsCommitted: number) {
    super("XACTIONS_PARTIAL: page budget reached; resume from committed checkpoint");
    this.name = "HttpPartialProgressError";
  }
}


export function isXActionsEligible(kind: string, payload: Parsed, originalPayload?: unknown): boolean {
  // Zod strips extra fields from TimelinePayload/ProfilePayload. Therefore,
  // judging archive markers ONLY on parsed payload can silently send an
  // existing historical job to the HTTP engine. Inspect the original JSON too.
  let raw: unknown = originalPayload ?? payload;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { return false; }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const original = raw as Record<string, unknown>;
  const archiveMarkers = [
    "history_run_id", "history_author", "history_since", "history_until",
    "history_max_id", "discovery_source", "list_source_id",
    "list_since_id", "list_max_id",
  ] as const;
  if (archiveMarkers.some(key => Object.hasOwn(original, key) || Object.hasOwn(payload, key))) return false;
  if (kind === "profile" || kind === "timeline") return true;
  if (kind === "members") return typeof payload.list_id === "string" && /^[0-9]{1,25}$/.test(payload.list_id);
  // ListTimeline is chronological; it cannot reproduce top-ranked list
  // search semantics. Keep "top" tasks on the original Playwright parser.
  return kind === "search" && (payload.sort === undefined || payload.sort === "latest")
    && typeof payload.query === "string" && listId(payload.query) !== null;
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
  beforeRequest?: () => Promise<void>;
}

export async function executeXActionsReadTask(ctx: XActionsTaskContext): Promise<void> {
  const { task, payload, account, authState, leaseOwner, workerId, signal, publish } = ctx;
  if (!isXActionsEligible(task.kind, payload, task.payloadJson)) throw new Error("XActions: task is not eligible for HTTP");
  const accountKind = task.kind === "search" ? "search" : task.kind === "timeline" ? "timeline" : "profile";
  const charge = ctx.beforeRequest ?? createHttpQuotaGate(accountKind,
    weight => reserveAdditionalHttpRequest(account.name, leaseOwner, weight));
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
    await persistProfile(profile, task.id, account.name, lease, { transport: "http" });
    return;
  }

  const sourceKind = task.kind === "timeline" ? "timeline" : task.kind === "members" ? "members" : "list";
  const sourceKey = sourceKind === "timeline" ? String(payload.handle).toLowerCase() :
    sourceKind === "members" ? String(payload.list_id) : listId(String(payload.query))!;
  const limit = Number(payload.limit);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("XActions: invalid task limit");
  // HTTP pages do not guarantee 20 posts/members each. Bound one attempt,
  // and continue later from the durable cursor if more pages are required.
  const pageBudget = Math.min(250, Math.max(15, Math.ceil(limit / 20) * 5));
  const authorId = sourceKind === "timeline" ? await engine.resolveUserId(sourceKey) : null;
  const key: HttpCheckpointKey = {
    taskId: task.id, sourceKind, sourceKey,
    queryFingerprint: httpQueryFingerprint({ sourceKind, sourceKey, authorId, limit, graphQlCount: 20, version: "3.5.0" }),
  };
  const saved = await loadHttpCheckpoint(key);
  if (saved?.completed || (saved && saved.itemsCommitted >= limit)) return;
  let nextToFetch = saved?.cursor ?? null;
  let totalItems = saved?.itemsCommitted ?? 0;
  const pageOptions = { initialCursor: nextToFetch, maxPages: pageBudget,
    stopAfterItems: limit, itemsCommittedBefore: totalItems,
    consecutiveEmptyBefore: saved?.consecutiveEmptyPages ?? 0, signal };
  if (sourceKind === "members") {
    const result = await runCursorPages(async cursor => {
      signal.throwIfAborted();
      return engine.listMembersPage(sourceKey, cursor);
    }, async page => {
      signal.throwIfAborted();
      await publish({ phase: "saving" });
      const newItems = await persistXActionsMemberPage({
        ...key, lease, previousCursor: nextToFetch,
      }, page);
      nextToFetch = page.nextCursor;
      totalItems += newItems;
      await publish({ phase: "collecting", found: totalItems, limit });
      return newItems;
    }, pageOptions);
    if (!result.completed && result.itemsCommitted < limit) {
      throw new HttpPartialProgressError(result.pagesCommitted, result.itemsCommitted);
    }
  } else {
    const result = await runCursorPages(async cursor => {
      signal.throwIfAborted();
      return sourceKind === "timeline" ? engine.timelinePage(authorId!, cursor) : engine.listPage(sourceKey, cursor);
    }, async page => {
      signal.throwIfAborted();
      await publish({ phase: "saving" });
      const newItems = await persistXActionsTweetPage({
        ...key, lease,
        mint: sourceKind === "list" ? task.mint : null,
        sourceQuery: sourceKind === "list" ? `list:${sourceKey}` : null,
        previousCursor: nextToFetch,
      }, page);
      nextToFetch = page.nextCursor;
      totalItems += newItems;
      await publish({ phase: "collecting", found: totalItems, limit });
      return newItems;
    }, pageOptions);
    if (!result.completed && result.itemsCommitted < limit) {
      throw new HttpPartialProgressError(result.pagesCommitted, result.itemsCommitted);
    }
  }
}
