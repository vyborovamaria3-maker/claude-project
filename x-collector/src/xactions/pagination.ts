/**
 * HTTP cursor is opaque. It must never replace a numerical history_max_id.
 * The caller's commitPage MUST persist both items and the next cursor in the
 * same database transaction, checking task and account leases before writing.
 */
export interface CursorPage<T> {
  items: readonly T[];
  nextCursor: string | null;
}

export interface PageCommit<T> extends CursorPage<T> {
  pageNumber: number;
  completed: boolean;
}

export interface CursorRunOptions {
  initialCursor?: string | null;
  maxPages: number;
  /** Optional task item target; a cursor after this target is not exhaustion. */
  stopAfterItems?: number;
  /** Already persisted items when resuming an HTTP checkpoint. */
  itemsCommittedBefore?: number;
  signal?: AbortSignal;
}

export interface CursorRunResult {
  pagesCommitted: number;
  itemsCommitted: number;
  nextCursor: string | null;
  completed: boolean;
}

export async function runCursorPages<T>(
  fetchPage: (cursor: string | null, signal?: AbortSignal) => Promise<CursorPage<T>>,
  commitPage: (page: PageCommit<T>) => Promise<void>,
  options: CursorRunOptions,
): Promise<CursorRunResult> {
  if (!Number.isSafeInteger(options.maxPages) || options.maxPages < 1) {
    throw new Error("XActions: maxPages must be a positive integer");
  }

  const stopAfter = options.stopAfterItems;
  const prior = options.itemsCommittedBefore ?? 0;
  if (stopAfter !== undefined && (!Number.isSafeInteger(stopAfter) || stopAfter < 1)) {
    throw new Error("XActions: invalid item target");
  }
  if (!Number.isSafeInteger(prior) || prior < 0) throw new Error("XActions: invalid saved item count");

  let cursor = options.initialCursor ?? null;
  const visited = new Set<string>();
  let itemsCommitted = prior;
  if (stopAfter !== undefined && itemsCommitted >= stopAfter) {
    return { pagesCommitted: 0, itemsCommitted, nextCursor: cursor, completed: false };
  }

  for (let pageNumber = 1; pageNumber <= options.maxPages; pageNumber++) {
    options.signal?.throwIfAborted();
    if (cursor !== null) {
      if (visited.has(cursor)) throw new Error("XActions: pagination cursor loop");
      visited.add(cursor);
    }

    const page = await fetchPage(cursor, options.signal);
    options.signal?.throwIfAborted();

    if (!Array.isArray(page.items) || (page.nextCursor !== null && typeof page.nextCursor !== "string")) {
      throw new Error("XActions: malformed pagination page");
    }
    if (page.nextCursor === cursor && cursor !== null) throw new Error("XActions: pagination did not advance");
    if (page.nextCursor !== null && page.nextCursor.length === 0) throw new Error("XActions: empty pagination cursor");

    const completed = page.nextCursor === null;
    // Advance ONLY after the caller's atomic DB commit has resolved.
    await commitPage({ ...page, pageNumber, completed });
    cursor = page.nextCursor;
    itemsCommitted += page.items.length;

    if (completed) return { pagesCommitted: pageNumber, itemsCommitted, nextCursor: null, completed: true };
    // Never discard the remainder of an HTTP page. The target is a minimum
    // observed count and the opaque next cursor stays durable for later reads.
    if (stopAfter !== undefined && itemsCommitted >= stopAfter) {
      return { pagesCommitted: pageNumber, itemsCommitted, nextCursor: cursor, completed: false };
    }
  }

  return { pagesCommitted: options.maxPages, itemsCommitted, nextCursor: cursor, completed: false };
}
