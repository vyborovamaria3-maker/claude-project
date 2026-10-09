/**
 * Конфигурация Signal Engine: секция v1 (SIGNAL_CONFIG) и секция v2
 * (WEIGHTED_CONFIG + PRIORITY_CONFIG). Веса живут только здесь.
 */
import { AUTHOR_CONFIG } from "../authors/config";

/**
 * Коэффициенты Signal Engine v1. Все веса и пороги — только здесь,
 * чтобы формулу можно было объяснить и перенастроить без правки кода.
 *
 * score = frequency + growth + authors + velocity, каждый фактор
 * нормируется в [0, weight], сумма весов = 100 → score ∈ [0, 100].
 */
export interface SignalScoringConfig {
  /** Окно наблюдения в часах (текущий период). */
  windowHours: number;
  factors: {
    /** Упоминаний в окне для максимальных баллов. */
    frequency: { weight: number; fullAt: number };
    /** Рост в % от предыдущего периода для максимальных баллов. */
    growth: { weight: number; fullAtPercent: number };
    /** Уникальных авторов для максимальных баллов. */
    authors: { weight: number; fullAt: number };
    /** Упоминаний в час для максимальных баллов. */
    velocity: { weight: number; fullAtPerHour: number };
  };
  /** Пороги уровней: score < medium → LOW, < high → MEDIUM, < critical → HIGH, иначе CRITICAL. */
  levels: { medium: number; high: number; critical: number };
  /** Минимальный score, при котором сигнал считается найденным. */
  minScore: number;
}

export const SIGNAL_CONFIG: SignalScoringConfig = {
  windowHours: 24,
  factors: {
    frequency: { weight: 30, fullAt: 10 },
    growth: { weight: 30, fullAtPercent: 100 },
    authors: { weight: 20, fullAt: 5 },
    velocity: { weight: 20, fullAtPerHour: 1 },
  },
  levels: { medium: 50, high: 70, critical: 85 },
  minScore: 50,
};

/** Источник сигналов в signal_history (расширен миграцией 014). */
export const SIGNAL_SOURCE = "entity";

export function totalWeight(config: SignalScoringConfig = SIGNAL_CONFIG): number {
  const f = config.factors;
  return f.frequency.weight + f.growth.weight + f.authors.weight + f.velocity.weight;
}

/**
 * Коэффициенты Weighted Signal Engine v2. Отдельный слой поверх v1:
 * score v1 не меняется, weightedScore = base * w1 + influence * w2 + trend * w3.
 * Сумма весов обязана быть равна 1 (проверяется totalWeightedWeight()).
 */
export interface WeightedSignalConfig {
  weights: {
    /** Вклад базового сигнала v1 (score ∈ [0,100]). */
    baseSignal: number;
    /** Вклад Influence Score автора (KOL ∈ [0,100], без KOL = 0). */
    authorInfluence: number;
    /** Вклад силы восходящего тренда (trendStrength ∈ [0,100]). */
    trendStrength: number;
  };
  /** Границы уровней v2: 0-39 LOW, 40-69 MEDIUM, 70-84 HIGH, 85-100 CRITICAL. */
  levels: { medium: number; high: number; critical: number };
}

export const WEIGHTED_CONFIG: WeightedSignalConfig = {
  weights: { baseSignal: 0.6, authorInfluence: 0.25, trendStrength: 0.15 },
  levels: { medium: 40, high: 70, critical: 85 },
};

/** Сумма весов v2. Инвариант: должна быть равна 1. */
export function totalWeightedWeight(config: WeightedSignalConfig = WEIGHTED_CONFIG): number {
  const w = config.weights;
  return w.baseSignal + w.authorInfluence + w.trendStrength;
}

/** Пороги Priority layer (signal + KOL + growth → LOW/NORMAL/IMPORTANT/URGENT). */
export interface PriorityConfig {
  /** Influence Score >= порога → автор считается KOL для priority. */
  kolThreshold: number;
  /** Рост в % от предыдущего окна, при котором сигнал считается растущим. */
  growthPercent: number;
}

export const PRIORITY_CONFIG: PriorityConfig = {
  kolThreshold: AUTHOR_CONFIG.minScoreToDetect,
  // == STABLE_GROWTH_THRESHOLD (analytics/trends): рост >= 10% → rising.
  growthPercent: 10,
};
