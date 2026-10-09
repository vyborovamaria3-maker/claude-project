import { q, exec, closePool } from "../lib/trade/pg";
import { processTweetEntities } from "../src/intelligence/entities/processor";
import { metrics } from "../src/core/metrics";
import { logger } from "../src/core/logger";

const TAG = "[entity-worker]";

interface PendingTweet {
  tweet_id: string;
  text: string | null;
}

interface BatchArgs {
  limit: number;
  /** Игнорировать маркер processed и переразобрать уже обработанные твиты. */
  all: boolean;
}

function parseArgs(argv: string[]): BatchArgs {
  const raw = Number(argv[2] ?? 100);
  const limit = Number.isFinite(raw) ? Math.floor(raw) : 100;
  return {
    limit: Math.max(1, Math.min(1000, limit)),
    all: argv.includes("--all"),
  };
}

async function main() {
  const { limit, all } = parseArgs(process.argv);
  const started = Date.now();

  const pending = await q<PendingTweet>(
    `SELECT tweet_id, text
     FROM twitter_tweets
     WHERE ${all ? "TRUE" : "entities_processed_at IS NULL"}
     ORDER BY first_seen_at ASC NULLS LAST
     LIMIT $1`,
    [limit]
  );
  if (pending.length === 0) {
    logger.info("no pending tweets", { limit, ms: Date.now() - started });
    console.log(`${TAG} no pending tweets`);
    return;
  }

  const byType: Record<string, number> = {};
  const processed: string[] = [];
  let entityCount = 0;
  let errors = 0;

  for (const tweet of pending) {
    try {
      const entities = await processTweetEntities(tweet);
      entityCount += entities.length;
      for (const e of entities) byType[e.type] = (byType[e.type] ?? 0) + 1;
      processed.push(tweet.tweet_id);
    } catch (e) {
      errors++;
      metrics.entityErrors++;
      logger.error("entity extraction failed", {
        tweet_id: tweet.tweet_id,
        error: String(e instanceof Error ? e.message : e),
      });
    }
  }

  if (processed.length > 0) {
    await exec(
      `UPDATE twitter_tweets SET entities_processed_at = $1 WHERE tweet_id = ANY($2::text[])`,
      [Date.now(), processed]
    );
  }

  const remaining = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM twitter_tweets WHERE entities_processed_at IS NULL`
  );

  const breakdown = Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `${type}=${n}`)
    .join(" ");

  console.log(`${TAG} batch: tweets=${pending.length}, processed=${processed.length}, entities=${entityCount}, errors=${errors}`);
  console.log(`${TAG} by type: ${breakdown || "-"}`);
  console.log(`${TAG} pending remaining: ${remaining[0]?.n ?? "?"}`);
  console.log(`${TAG} metrics: entitiesExtracted=${metrics.entitiesExtracted}, entityErrors=${metrics.entityErrors}`);
  logger.info("entity batch done", {
    tweets: pending.length,
    processed: processed.length,
    entities: entityCount,
    errors,
    ms: Date.now() - started,
  });

  if (errors > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(`${TAG} failed:`, e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => {}));
