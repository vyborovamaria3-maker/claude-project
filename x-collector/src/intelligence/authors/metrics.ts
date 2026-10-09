import { q } from "../../../lib/trade/pg";
import { AUTHOR_CONFIG, type AuthorScoringConfig } from "./config";

/** Метрики автора. activityScore — нормированный 0..100 показатель активности. */
export interface AuthorMetrics {
  handle: string;
  tweets: number;
  entities: number;
  tokens: number;
  uniqueEntities: number;
  /** Уникальные дни с твитами — нужно для consistency. */
  activeDays: number;
  avgEngagement: number;
  activityScore: number;
}

/** Строка агрегата twitter_tweets ⋈ tweet_entities. */
export interface AuthorRow {
  handle: string;
  tweets: number | string;
  entities: number | string;
  tokens: number | string;
  unique_entities: number | string;
  active_days: number | string;
  engagement_sum: number | string;
}

export interface AuthorMetricsOptions {
  /** Окно в часах от текущего момента. Без значения — вся история. */
  hours?: number;
  config?: AuthorScoringConfig;
}

/** activityScore = 100 × min(tweets / fullAtTweets, 1), целое. */
export function activityScoreFor(tweets: number, config: AuthorScoringConfig = AUTHOR_CONFIG): number {
  const fullAt = config.factors.activity.fullAtTweets;
  if (!(tweets > 0) || fullAt <= 0) return 0;
  return Math.min(Math.round((tweets / fullAt) * 100), 100);
}

/** Агрегат строки → AuthorMetrics. Чистая функция, используется и в тестах. */
export function metricsFromRow(
  row: AuthorRow,
  options: AuthorMetricsOptions = {},
): AuthorMetrics {
  const config = options.config ?? AUTHOR_CONFIG;
  const tweets = Number(row.tweets);
  const engagementSum = Number(row.engagement_sum);
  return {
    handle: row.handle,
    tweets,
    entities: Number(row.entities),
    tokens: Number(row.tokens),
    uniqueEntities: Number(row.unique_entities),
    activeDays: Number(row.active_days),
    avgEngagement: tweets > 0 ? Math.round((engagementSum / tweets) * 100) / 100 : 0,
    activityScore: activityScoreFor(tweets, config),
  };
}

const AUTHOR_AGG_SQL = `SELECT t.handle,
       COUNT(DISTINCT t.tweet_id)::int AS tweets,
       COUNT(e.id)::int AS entities,
       COUNT(DISTINCT CASE WHEN e.entity_type = 'TOKEN' THEN e.value END)::int AS tokens,
       COUNT(DISTINCT e.value)::int AS unique_entities,
       COUNT(DISTINCT (COALESCE(t.posted_at, t.first_seen_at) / 86400000))::int AS active_days,
       COALESCE(SUM(t.likes + t.retweets + t.replies), 0)::bigint AS engagement_sum
  FROM twitter_tweets t
  LEFT JOIN tweet_entities e ON e.tweet_id = t.tweet_id`;

async function fetchAuthorRows(
  options: AuthorMetricsOptions & { handle?: string; limit?: number },
): Promise<AuthorRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.hours != null && options.hours > 0) {
    params.push(Date.now() - options.hours * 3_600_000);
    where.push(`COALESCE(t.posted_at, t.first_seen_at) >= $${params.length}`);
  }
  if (options.handle) {
    params.push(options.handle);
    where.push(`t.handle = $${params.length}`);
  }
  let sql = AUTHOR_AGG_SQL;
  if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
  sql += " GROUP BY t.handle";
  if (options.limit != null && options.limit > 0) {
    params.push(options.limit);
    sql += ` ORDER BY tweets DESC LIMIT $${params.length}`;
  }
  return q<AuthorRow>(sql, params);
}

/**
 * Метрики одного автора из twitter_tweets + tweet_entities.
 * null — у автора нет твитов в выбранном окне.
 */
export async function calculateAuthorMetrics(
  handle: string,
  options: AuthorMetricsOptions = {},
): Promise<AuthorMetrics | null> {
  const rows = await fetchAuthorRows({ ...options, handle });
  if (rows.length === 0) return null;
  return metricsFromRow(rows[0], options);
}

/** Метрики всех авторов (по активности). */
export async function listAuthorMetrics(
  options: AuthorMetricsOptions & { limit?: number } = {},
): Promise<AuthorMetrics[]> {
  const rows = await fetchAuthorRows(options);
  return rows.map((row) => metricsFromRow(row, options));
}
