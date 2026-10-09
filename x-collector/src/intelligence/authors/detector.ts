import { metrics } from "../../core/metrics";
import { AUTHOR_CONFIG, type AuthorScoringConfig } from "./config";
import { listAuthorMetrics, type AuthorMetrics, type AuthorMetricsOptions } from "./metrics";
import {
  calculateInfluenceScore, selectKOLs,
  type AuthorFactors, type AuthorInfluence, type AuthorLevel,
} from "./scorer";

export interface DetectedKOL {
  handle: string;
  score: number;
  level: AuthorLevel;
  metrics: AuthorMetrics;
  factors: AuthorFactors;
}

export interface DetectKOLsOptions extends AuthorMetricsOptions {
  /** Порог отсечки score. default config.minScoreToDetect (60) */
  minScore?: number;
  /** Сколько строк вернуть. default 20 */
  limit?: number;
  config?: AuthorScoringConfig;
}

/**
 * Детектор KOL: метрики всех авторов (twitter_tweets × tweet_entities) →
 * Influence Score → отсечка score >= minScore, сортировка по score DESC.
 */
export async function detectKOLs(options: DetectKOLsOptions = {}): Promise<DetectedKOL[]> {
  const config = options.config ?? AUTHOR_CONFIG;
  const minScore = options.minScore ?? config.minScoreToDetect;
  const limit = options.limit ?? 20;

  const authors = await listAuthorMetrics({ hours: options.hours, config });
  const scored: AuthorInfluence[] = authors.map((author) => calculateInfluenceScore(author, config));
  const selected = selectKOLs(scored, minScore).slice(0, limit);
  metrics.kolsDetected += selected.length;

  const metricsByHandle = new Map(authors.map((a) => [a.handle, a]));
  const kols: DetectedKOL[] = [];
  for (const kol of selected) {
    const authorMetrics = metricsByHandle.get(kol.handle);
    if (!authorMetrics) continue;
    kols.push({
      handle: kol.handle,
      score: kol.score,
      level: kol.level,
      metrics: authorMetrics,
      factors: kol.factors,
    });
  }
  return kols;
}
