import { tx } from "../../../lib/trade/pg";
import type { PoolClient } from "pg";
import { metrics } from "../../core/metrics";
import { extractEntities, ExtractedEntity } from "./extractor";

export interface ProcessableTweet {
  tweet_id: string;
  text: string | null;
}

/**
 * Сохраняет сущности твита в существующую таблицу tweet_entities (005_nlp.sql).
 * DELETE + INSERT в одной транзакции: повторный запуск идемпотентен.
 */
export async function saveTweetEntities(tweetId: string, entities: ExtractedEntity[], client?: PoolClient): Promise<number> {
  const now = Date.now();
  const save = async (c: PoolClient) => {
    await c.query("DELETE FROM tweet_entities WHERE tweet_id = $1", [tweetId]);
    if (entities.length === 0) return 0;
    const values: unknown[] = [];
    const placeholders = entities.map((e, i) => {
      const off = i * 6;
      values.push(tweetId, e.type, e.value, e.position, e.confidence, now);
      return `($${off + 1},$${off + 2},$${off + 3},$${off + 4},$${off + 5},$${off + 6})`;
    }).join(",");
    const r = await c.query(
      `INSERT INTO tweet_entities (tweet_id, entity_type, value, position, confidence, extracted_at)
       VALUES ${placeholders}`,
      values
    );
    return r.rowCount ?? 0;
  };
  return client ? save(client) : tx(save);
}

/** twitter_tweets → extractEntities → tweet_entities. Возвращает сохранённые сущности. */
export async function processTweetEntities(tweet: ProcessableTweet, client?: PoolClient): Promise<ExtractedEntity[]> {
  const entities = extractEntities(tweet.text ?? "");
  const saved = await saveTweetEntities(tweet.tweet_id, entities, client);
  metrics.entitiesExtracted += saved;
  return entities;
}
