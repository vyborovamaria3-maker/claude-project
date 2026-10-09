import { q } from "../../../lib/trade/pg";
import { metrics } from "../../core/metrics";
import type { EntityType } from "../entities/extractor";

export type TrendDirection = "rising" | "stable" | "falling";

export interface TrendResult {
  value: string;
  current: number;
  previous: number;
  growthPercent: number;
  trend: TrendDirection;
}

export interface TrendInput {
  value: string;
  current: number;
  previous: number;
}

export interface TrendTarget {
  value: string;
  type?: EntityType;
  /** Длина каждого периода в часах. default 24 */
  hours?: number;
}

/** Рост/падение внутри ±порога считается flat. */
export const STABLE_GROWTH_THRESHOLD = 10;
export const DEFAULT_TREND_HOURS = 24;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Чистый расчёт тренда: текущий период против предыдущего.
 * previous = 0 → рост считается 100% при ненулевом current, иначе 0%.
 */
export function computeTrend(input: TrendInput): TrendResult {
  const current = Math.max(0, input.current);
  const previous = Math.max(0, input.previous);
  const growthPercent = previous === 0
    ? (current > 0 ? 100 : 0)
    : round2(((current - previous) / previous) * 100);

  const trend: TrendDirection = growthPercent >= STABLE_GROWTH_THRESHOLD
    ? "rising"
    : growthPercent <= -STABLE_GROWTH_THRESHOLD
      ? "falling"
      : "stable";

  return { value: input.value, current, previous, growthPercent, trend };
}

/**
 * Считает упоминания сущности в текущем окне и в предыдущем окне той же длины,
 * затем прогоняет их через computeTrend. Периоды ограничены по времени публикации твита.
 */
export async function calculateTrend(entity: TrendTarget): Promise<TrendResult> {
  const hours = Number.isFinite(entity.hours) && (entity.hours as number) > 0
    ? Math.floor(entity.hours as number)
    : DEFAULT_TREND_HOURS;
  const windowMs = hours * 3_600_000;
  const now = Date.now();
  const currentStart = now - windowMs;
  const previousStart = now - windowMs * 2;

  const rows = await q<{ current_mentions: number | string; previous_mentions: number | string }>(
    `SELECT COUNT(*) FILTER (WHERE COALESCE(t.posted_at, t.first_seen_at) >= $2)::int AS current_mentions,
            COUNT(*) FILTER (WHERE COALESCE(t.posted_at, t.first_seen_at) >= $3
                              AND COALESCE(t.posted_at, t.first_seen_at) < $2)::int AS previous_mentions
       FROM tweet_entities e
       JOIN twitter_tweets t ON t.tweet_id = e.tweet_id
      WHERE e.value = $1
        AND ($4::text IS NULL OR e.entity_type = $4)`,
    [entity.value, currentStart, previousStart, entity.type ?? null]
  );
  metrics.analyticsRuns += 1;

  const row = rows[0];
  return computeTrend({
    value: entity.value,
    current: Number(row?.current_mentions ?? 0),
    previous: Number(row?.previous_mentions ?? 0),
  });
}
