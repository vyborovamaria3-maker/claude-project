/**
 * Коэффициенты Influence Score v1. Все веса и нормировки — только здесь.
 *
 * Influence Score = activity + entityQuality + consistency + engagement,
 * каждый фактор ∈ [0, weight], сумма весов = 100 → score ∈ [0, 100].
 */
export interface AuthorScoringConfig {
  factors: {
    /** Активность: твитов для максимальных баллов. */
    activity: { weight: number; fullAtTweets: number };
    /** Качество сущностей: токенов / уникальных сущностей для максимума + доля токенов. */
    entityQuality: { weight: number; tokensFullAt: number; uniqueFullAt: number; tokenShare: number };
    /** Регулярность: активных дней для максимальных баллов. */
    consistency: { weight: number; fullAtActiveDays: number };
    /** Вовлечённость: среднего (likes+retweets+replies) на твит для максимума. */
    engagement: { weight: number; fullAtAvgEngagement: number };
  };
  /** Границы уровней: score >= kol → KOL, >= high → HIGH, >= medium → MEDIUM, иначе LOW. */
  levels: { medium: number; high: number; kol: number };
  /** Порог детектора KOL. */
  minScoreToDetect: number;
}

export const AUTHOR_CONFIG: AuthorScoringConfig = {
  factors: {
    activity: { weight: 25, fullAtTweets: 20 },
    entityQuality: { weight: 25, tokensFullAt: 5, uniqueFullAt: 10, tokenShare: 0.6 },
    consistency: { weight: 25, fullAtActiveDays: 7 },
    engagement: { weight: 25, fullAtAvgEngagement: 20 },
  },
  levels: { medium: 31, high: 61, kol: 81 },
  minScoreToDetect: 60,
};

export function totalWeight(config: AuthorScoringConfig = AUTHOR_CONFIG): number {
  const f = config.factors;
  return f.activity.weight + f.entityQuality.weight + f.consistency.weight + f.engagement.weight;
}
