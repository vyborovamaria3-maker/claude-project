import { metrics } from "../../core/metrics";
import type { TrendDirection } from "../analytics/trends";
import { WEIGHTED_CONFIG, type WeightedSignalConfig } from "./config";
import type { SignalLevel } from "./scorer";

/**
 * Weighted Signal Engine v2. Отдельный слой поверх v1: calculateSignalScore()
 * не вызывается и не меняется, старый score остаётся baseScore.
 *
 * weightedScore = baseSignal * 0.6 + authorInfluence * 0.25 + trendStrength * 0.15
 * (веса — в WEIGHTED_CONFIG, сумма = 1). Каждый вклад — целые баллы,
 * weightedScore = сумма вкладов, clamp [0, 100].
 */

/** Тренд контекста: направление (из analytics/trends) либо рост в % от предыдущего окна. */
export type WeightedTrend = TrendDirection | number;

/** Сигнал v1, поверх которого считается weighted-слой. */
export interface WeightedSignalInput {
  entity: string;
  /** Base score v1 ∈ [0, 100]. */
  score: number;
  level: SignalLevel;
}

/**
 * Контекст качества источника. influenceScore/trend входят в формулу;
 * uniqueAuthors/velocity — входные метрики для отчёта и priority, в формулу v2 не входят.
 */
export interface WeightedSignalContext {
  /** Influence Score KOL-автора сущности; 0 — KOL нет. */
  influenceScore: number;
  uniqueAuthors: number;
  trend: WeightedTrend;
  velocity: number;
}

/** Вклад каждого фактора в weightedScore, целые баллы. */
export interface WeightedFactors {
  baseSignal: number;
  authorInfluence: number;
  trendStrength: number;
}

export interface WeightedSignalScore {
  /** score v1, продублированный для отчёта. */
  baseScore: number;
  weightedScore: number;
  level: SignalLevel;
  factors: WeightedFactors;
}

/** Нормализация в [0, 100]: нечисловые, отрицательные и infinity считаются нулём. */
function normalizeScore(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 100 ? 100 : value;
}

/**
 * Сила восходящего тренда ∈ [0, 100].
 * Число = рост в % от предыдущего окна (cap 100, падение → 0);
 * направление: rising → 100, stable/falling → 0.
 */
export function trendStrengthPercent(trend: WeightedTrend): number {
  if (typeof trend === "number") return normalizeScore(trend);
  return trend === "rising" ? 100 : 0;
}

/** Границы v2: 0-39 LOW, 40-69 MEDIUM, 70-84 HIGH, 85-100 CRITICAL. */
export function resolveWeightedLevel(
  score: number,
  config: WeightedSignalConfig = WEIGHTED_CONFIG,
): SignalLevel {
  if (score >= config.levels.critical) return "CRITICAL";
  if (score >= config.levels.high) return "HIGH";
  if (score >= config.levels.medium) return "MEDIUM";
  return "LOW";
}

/**
 * Чистый расчёт weighted-сигнала. Ничего не пишет в БД.
 * `signal.level` не используется для результата: уровень пересчитывается
 * по weightedScore с порогами v2 (WEIGHTED_CONFIG.levels).
 */
export function calculateWeightedSignal(
  signal: WeightedSignalInput,
  context: WeightedSignalContext,
  config: WeightedSignalConfig = WEIGHTED_CONFIG,
): WeightedSignalScore {
  const w = config.weights;
  const baseScore = normalizeScore(signal.score);
  const influenceScore = normalizeScore(context.influenceScore);
  const strength = trendStrengthPercent(context.trend);

  const factors: WeightedFactors = {
    baseSignal: Math.round(w.baseSignal * baseScore),
    authorInfluence: Math.round(w.authorInfluence * influenceScore),
    trendStrength: Math.round(w.trendStrength * strength),
  };
  const weightedScore = Math.min(
    Math.max(factors.baseSignal + factors.authorInfluence + factors.trendStrength, 0),
    100,
  );
  metrics.weightedSignalsCalculated += 1;

  return {
    baseScore,
    weightedScore,
    level: resolveWeightedLevel(weightedScore, config),
    factors,
  };
}
