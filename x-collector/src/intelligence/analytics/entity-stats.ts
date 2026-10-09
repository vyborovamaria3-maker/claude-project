import { q } from "../../../lib/trade/pg";
import { metrics } from "../../core/metrics";
import type { EntityType } from "../entities/extractor";

export type { EntityType };

export interface EntityStat {
  entity_type: EntityType;
  value: string;
  mentions: number;
  unique_tweets: number;
  first_seen: number;
  last_seen: number;
}

export interface TopEntitiesOptions {
  /** Фильтр по типу сущности: TOKEN | MENTION | URL | HASHTAG. Без фильтра — все типы. */
  type?: EntityType;
  /** Окно в часах от текущего момента. default 24 */
  hours?: number;
  /** Сколько строк вернуть. default 20 */
  limit?: number;
}

/** Строка tweet_entities (+ время твита из twitter_tweets) для эталонной агрегации. */
export interface EntityRecord {
  entity_type: string;
  value: string;
  tweet_id: string;
  extracted_at: number;
  /** COALESCE(twitter_tweets.posted_at, first_seen_at), мс. */
  posted_at?: number | null;
}

export const DEFAULT_HOURS = 24;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 500;

export function resolveTopEntitiesOptions(
  options: TopEntitiesOptions = {},
): { type: EntityType | undefined; hours: number; limit: number } {
  const hours = Number.isFinite(options.hours) && (options.hours as number) > 0
    ? Math.floor(options.hours as number)
    : DEFAULT_HOURS;
  const limit = Number.isFinite(options.limit) && (options.limit as number) > 0
    ? Math.min(Math.floor(options.limit as number), MAX_LIMIT)
    : DEFAULT_LIMIT;
  return { type: options.type, hours, limit };
}

/** mentions DESC -> unique_tweets DESC -> value ASC. limit применяется после сортировки. */
export function rankEntityStats(stats: EntityStat[], limit = MAX_LIMIT): EntityStat[] {
  return [...stats]
    .sort((a, b) =>
      b.mentions - a.mentions ||
      b.unique_tweets - a.unique_tweets ||
      a.value.localeCompare(b.value))
    .slice(0, limit);
}

/**
 * Эталонная агрегация той же семантики, что и SQL в getTopEntities:
 * mentions считаются внутри окна hours, first_seen/last_seen — по всему диапазону данных.
 * Используется в тестах и офлайне; в проде работает SQL-версия.
 */
export function aggregateEntities(rows: EntityRecord[], options: TopEntitiesOptions = {}): EntityStat[] {
  const { type, hours, limit } = resolveTopEntitiesOptions(options);
  const cutoff = Date.now() - hours * 3_600_000;

  const byKey = new Map<string, EntityStat & { tweets: Set<string> }>();
  for (const row of rows) {
    if (type && row.entity_type !== type) continue;
    const key = row.entity_type + " " + row.value;
    let agg = byKey.get(key);
    if (!agg) {
      agg = {
        entity_type: row.entity_type as EntityType,
        value: row.value,
        mentions: 0,
        unique_tweets: 0,
        first_seen: row.extracted_at,
        last_seen: row.extracted_at,
        tweets: new Set<string>(),
      };
      byKey.set(key, agg);
    }
    const ts = row.posted_at ?? row.extracted_at;
    if (ts >= cutoff) {
      agg.mentions += 1;
      agg.tweets.add(row.tweet_id);
    }
    agg.first_seen = Math.min(agg.first_seen, row.extracted_at);
    agg.last_seen = Math.max(agg.last_seen, row.extracted_at);
  }

  const stats = [...byKey.values()]
    .filter((agg) => agg.mentions > 0)
    .map(({ tweets, ...stat }) => ({ ...stat, unique_tweets: tweets.size }));
  return rankEntityStats(stats, limit);
}

interface RawEntityRow {
  entity_type: string;
  value: string;
  mentions: number | string;
  unique_tweets: number | string;
  first_seen: number | string;
  last_seen: number | string;
}

function toEntityStat(row: RawEntityRow): EntityStat {
  return {
    entity_type: row.entity_type as EntityType,
    value: row.value,
    mentions: Number(row.mentions),
    unique_tweets: Number(row.unique_tweets),
    first_seen: Number(row.first_seen),
    last_seen: Number(row.last_seen),
  };
}

/**
 * Топ сущностей из tweet_entities × twitter_tweets за последние `hours`.
 * mentions — число упоминаний внутри окна; first_seen/last_seen — по всей истории.
 */
export async function getTopEntities(options: TopEntitiesOptions = {}): Promise<EntityStat[]> {
  const { type, hours, limit } = resolveTopEntitiesOptions(options);
  const cutoff = Date.now() - hours * 3_600_000;
  const rows = await q<RawEntityRow>(
    `SELECT e.entity_type,
            e.value,
            COUNT(*) FILTER (WHERE COALESCE(t.posted_at, t.first_seen_at) >= $1)::int AS mentions,
            COUNT(DISTINCT e.tweet_id) FILTER (WHERE COALESCE(t.posted_at, t.first_seen_at) >= $1)::int AS unique_tweets,
            MIN(e.extracted_at)::bigint AS first_seen,
            MAX(e.extracted_at)::bigint AS last_seen
       FROM tweet_entities e
       JOIN twitter_tweets t ON t.tweet_id = e.tweet_id
      WHERE ($2::text IS NULL OR e.entity_type = $2)
      GROUP BY e.entity_type, e.value
     HAVING COUNT(*) FILTER (WHERE COALESCE(t.posted_at, t.first_seen_at) >= $1) > 0
      ORDER BY mentions DESC, unique_tweets DESC, e.value ASC
      LIMIT $3`,
    [cutoff, type ?? null, limit]
  );
  metrics.analyticsRuns += 1;
  return rows.map(toEntityStat);
}
