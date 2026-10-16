import type { RawTweet } from "../../lib/trade/twitter-scraper";
import { persistTweets, type PersistenceLease } from "../../lib/trade/collector-store";
import { commitHttpPage, type HttpCheckpointKey, type HttpLease } from "./checkpoint-store";
import type { PageCommit } from "./pagination";

export interface HttpTweetPageContext extends HttpCheckpointKey {
  lease: HttpLease;
  mint: string | null;
  sourceQuery: string | null;
  /** The cursor used to fetch this page (from the last confirmed checkpoint). */
  previousCursor: string | null;
}

/**
 * Persist the entire parsed HTTP page and its next cursor together.
 * A failed INSERT or expired lease rolls everything back. A subsequent task
 * attempt must load its cursor from xc_http_checkpoints before fetching.
 */
export async function persistXActionsTweetPage(
  context: HttpTweetPageContext,
  page: PageCommit<RawTweet>,
): Promise<number> {
  let newItems = 0;
  const persistenceLease: PersistenceLease = {
    workerId: context.lease.workerId,
    attempt: context.lease.attempt,
    accountName: context.lease.accountName,
    accountOwner: context.lease.accountOwner,
  };
  await commitHttpPage({
    ...context,
    expectedCursor: context.previousCursor,
    nextCursor: page.nextCursor,
    completed: page.completed,
    itemsWritten: new Set(page.items.map(item => item.id)).size,
  }, async client => {
    newItems = await persistTweets(
      context.mint,
      [...page.items],
      context.sourceQuery,
      context.taskId,
      context.lease.accountName,
      persistenceLease,
      { client, transport: "http", rawResponse: page.rawResponse },
    );
    return newItems;
  });
  return newItems;
}
