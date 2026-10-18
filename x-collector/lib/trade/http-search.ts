import type { RawTweet, ScrapeOptions } from "./twitter-scraper";
import type { CursorPage } from "../../src/xactions/pagination";
import { HttpNoProgressError } from "../../src/xactions/pagination";

interface SearchReader {
  diagnosticSearchPage(query: string, sort: "top" | "latest", cursor: string | null): Promise<CursorPage<RawTweet>>;
}

/** Legacy tasks retain numeric checkpoints and their existing batch persistence. */
export async function collectHttpSearch(engine: SearchReader, query: string,
  opts: Pick<ScrapeOptions, "signal" | "onBatch" | "onProgress"> & { limit: number; sort: "top" | "latest" }) {
  const tweets: RawTweet[] = [];
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let emptyPages = 0;
  await opts.onProgress?.({ phase: "opening", limit: opts.limit });
  for (let pages = 0; pages < 40; pages++) {
    opts.signal?.throwIfAborted();
    const page = await engine.diagnosticSearchPage(query, opts.sort, cursor);
    opts.signal?.throwIfAborted();
    const batch: RawTweet[] = [];
    for (const tweet of page.items) {
      if (seen.has(tweet.id)) continue;
      seen.add(tweet.id);
      batch.push(tweet);
      if (tweets.length + batch.length >= opts.limit) break;
    }
    // Persist before moving the cursor. Failure leaves existing watermarks safe.
    if (batch.length) await opts.onBatch?.(batch, page.rawResponse);
    tweets.push(...batch);
    await opts.onProgress?.({ phase: "collecting", found: tweets.length, limit: opts.limit });
    if (tweets.length >= opts.limit || page.nextCursor === null) return tweets;
    if (cursors.has(page.nextCursor)) throw new HttpNoProgressError(pages + 1);
    cursors.add(page.nextCursor);
    emptyPages = batch.length ? 0 : emptyPages + 1;
    if (emptyPages >= 3) throw new HttpNoProgressError(pages + 1);
    cursor = page.nextCursor;
  }
  throw new Error("HTTP search page budget exhausted; committed batches retained for retry");
}
