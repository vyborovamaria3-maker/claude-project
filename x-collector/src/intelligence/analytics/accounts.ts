import { q } from "../../../lib/trade/pg";
import { metrics } from "../../core/metrics";

export interface AuthorStat {
  handle: string;
  tweets: number;
  entities: number;
  tokens: number;
}

export interface TopAuthorsOptions {
  /** Окно в часах от текущего момента. default 24 */
  hours?: number;
  /** Сколько строк вернуть. default 20 */
  limit?: number;
}

/** Строка "твит (+ его сущности)" для эталонной агрегации: одна строка = один join tweet×entity. */
export interface AuthorRecord {
  handle: string;
  tweet_id: string;
  /** COALESCE(twitter_tweets.posted_at, first_seen_at), мс. */
  posted_at?: number | null;
  first_seen_at?: number | null;
  entity_type?: string | null;
  entity_value?: string | null;
}

export const DEFAULT_AUTHORS_HOURS = 24;
export const DEFAULT_AUTHORS_LIMIT = 20;
export const MAX_AUTHORS_LIMIT = 500;

function resolveOptions(options: TopAuthorsOptions): { hours: number; limit: number } {
  const hours = Number.isFinite(options.hours) && (options.hours as number) > 0
    ? Math.floor(options.hours as number)
    : DEFAULT_AUTHORS_HOURS;
  const limit = Number.isFinite(options.limit) && (options.limit as number) > 0
    ? Math.min(Math.floor(options.limit as number), MAX_AUTHORS_LIMIT)
    : DEFAULT_AUTHORS_LIMIT;
  return { hours, limit };
}

/** tweets DESC -> entities DESC -> tokens DESC -> handle ASC. */
export function rankAuthors(authors: AuthorStat[], limit = MAX_AUTHORS_LIMIT): AuthorStat[] {
  return [...authors]
    .sort((a, b) =>
      b.tweets - a.tweets ||
      b.entities - a.entities ||
      b.tokens - a.tokens ||
      a.handle.localeCompare(b.handle))
    .slice(0, limit);
}

/**
 * Эталонная агрегация той же семантики, что и SQL в getTopAuthors:
 * tweets — уникальные твиты автора в окне, entities — строки tweet_entities,
 * tokens — уникальные TOKEN-значения. Используется в тестах и офлайне.
 */
export function aggregateAuthors(rows: AuthorRecord[], options: TopAuthorsOptions = {}): AuthorStat[] {
  const { hours, limit } = resolveOptions(options);
  const cutoff = Date.now() - hours * 3_600_000;

  const byHandle = new Map<string, { tweets: Set<string>; entities: number; tokens: Set<string> }>();
  for (const row of rows) {
    const ts = row.posted_at ?? row.first_seen_at;
    if (ts == null || ts < cutoff) continue;

    let agg = byHandle.get(row.handle);
    if (!agg) {
      agg = { tweets: new Set<string>(), entities: 0, tokens: new Set<string>() };
      byHandle.set(row.handle, agg);
    }
    agg.tweets.add(row.tweet_id);
    if (row.entity_type != null) {
      agg.entities += 1;
      if (row.entity_type === "TOKEN" && row.entity_value != null) agg.tokens.add(row.entity_value);
    }
  }

  const authors = [...byHandle.entries()].map(([handle, agg]) => ({
    handle,
    tweets: agg.tweets.size,
    entities: agg.entities,
    tokens: agg.tokens.size,
  }));
  return rankAuthors(authors, limit);
}

interface RawAuthorRow {
  handle: string;
  tweets: number | string;
  entities: number | string;
  tokens: number | string;
}

function toAuthorStat(row: RawAuthorRow): AuthorStat {
  return {
    handle: row.handle,
    tweets: Number(row.tweets),
    entities: Number(row.entities),
    tokens: Number(row.tokens),
  };
}

/** Топ авторов из twitter_tweets × tweet_entities за последние `hours`. */
export async function getTopAuthors(options: TopAuthorsOptions = {}): Promise<AuthorStat[]> {
  const { hours, limit } = resolveOptions(options);
  const cutoff = Date.now() - hours * 3_600_000;
  const rows = await q<RawAuthorRow>(
    `SELECT t.handle,
            COUNT(DISTINCT t.tweet_id)::int AS tweets,
            COUNT(e.id)::int AS entities,
            COUNT(DISTINCT CASE WHEN e.entity_type = 'TOKEN' THEN e.value END)::int AS tokens
       FROM twitter_tweets t
       LEFT JOIN tweet_entities e ON e.tweet_id = t.tweet_id
      WHERE COALESCE(t.posted_at, t.first_seen_at) >= $1
      GROUP BY t.handle
      ORDER BY tweets DESC, entities DESC, tokens DESC, t.handle ASC
      LIMIT $2`,
    [cutoff, limit]
  );
  metrics.analyticsRuns += 1;
  return rankAuthors(rows.map(toAuthorStat), limit);
}
