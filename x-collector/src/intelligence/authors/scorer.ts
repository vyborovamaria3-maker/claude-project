import { metrics } from "../../core/metrics";
import { AUTHOR_CONFIG, type AuthorScoringConfig } from "./config";
import type { AuthorMetrics } from "./metrics";

export type AuthorLevel = "LOW" | "MEDIUM" | "HIGH" | "KOL";

export interface AuthorFactors {
  activity: number;
  entityQuality: number;
  consistency: number;
  engagement: number;
}

export interface AuthorInfluence {
  handle: string;
  score: number;
  level: AuthorLevel;
  factors: AuthorFactors;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function factorPoints(weight: number, value: number, fullAt: number): number {
  if (fullAt <= 0) return 0;
  return Math.round(weight * clamp01(value / fullAt));
}

/** 0-30 LOW · 31-60 MEDIUM · 61-80 HIGH · 81-100 KOL (границы из config.levels). */
export function resolveAuthorLevel(score: number, config: AuthorScoringConfig = AUTHOR_CONFIG): AuthorLevel {
  if (score >= config.levels.kol) return "KOL";
  if (score >= config.levels.high) return "HIGH";
  if (score >= config.levels.medium) return "MEDIUM";
  return "LOW";
}

/**
 * Influence Score v1: activity + entityQuality + consistency + engagement,
 * по 25 баллов на фактор, score = сумма факторов, clamp [0, 100].
 * Ничего не пишет в БД; считает чисто по переданным метрикам.
 */
export function calculateInfluenceScore(
  author: AuthorMetrics,
  config: AuthorScoringConfig = AUTHOR_CONFIG,
): AuthorInfluence {
  const f = config.factors;
  const factors: AuthorFactors = {
    activity: factorPoints(f.activity.weight, author.tweets, f.activity.fullAtTweets),
    entityQuality: Math.round(
      f.entityQuality.weight * clamp01(
        f.entityQuality.tokenShare * clamp01(author.tokens / f.entityQuality.tokensFullAt) +
        (1 - f.entityQuality.tokenShare) * clamp01(author.uniqueEntities / f.entityQuality.uniqueFullAt),
      ),
    ),
    consistency: factorPoints(f.consistency.weight, author.activeDays, f.consistency.fullAtActiveDays),
    engagement: factorPoints(f.engagement.weight, author.avgEngagement, f.engagement.fullAtAvgEngagement),
  };

  const score = Math.min(Math.max(factors.activity + factors.entityQuality + factors.consistency + factors.engagement, 0), 100);
  metrics.authorsAnalyzed += 1;

  return { handle: author.handle, score, level: resolveAuthorLevel(score, config), factors };
}

/** Отсечка детектора: score >= minScore, сортировка score DESC → handle ASC. */
export function selectKOLs(
  rows: AuthorInfluence[],
  minScore: number = AUTHOR_CONFIG.minScoreToDetect,
): AuthorInfluence[] {
  return rows
    .filter((row) => row.score >= minScore)
    .sort((a, b) => b.score - a.score || a.handle.localeCompare(b.handle));
}
