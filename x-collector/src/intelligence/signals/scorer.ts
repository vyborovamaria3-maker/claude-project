import { metrics } from "../../core/metrics";
import { SIGNAL_CONFIG, type SignalScoringConfig } from "./config";

export type SignalLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface SignalInput {
  entity: string;
  currentMentions: number;
  previousMentions: number;
  uniqueAuthors: number;
  /** Упоминаний в час за окно наблюдения (currentMentions / windowHours). */
  velocity: number;
  /** Часы с первого упоминания. 0 — момент первого упоминания неизвестен. */
  age: number;
}

export interface SignalFactors {
  frequency: number;
  growth: number;
  authors: number;
  velocity: number;
}

export interface SignalScore {
  score: number;
  level: SignalLevel;
  factors: SignalFactors;
}

/** Нормализация: нечисловые и отрицательные значения считаются нулём. */
function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Рост в % от предыдущего периода. Семантика совпадает с Analytics v1:
 * previous = 0 при ненулевом current → +100%, иначе 0%.
 */
export function growthPercent(current: number, previous: number): number {
  const c = nonNegative(current);
  const p = nonNegative(previous);
  if (p === 0) return c > 0 ? 100 : 0;
  return ((c - p) / p) * 100;
}

export function resolveLevel(score: number, config: SignalScoringConfig = SIGNAL_CONFIG): SignalLevel {
  if (score >= config.levels.critical) return "CRITICAL";
  if (score >= config.levels.high) return "HIGH";
  if (score >= config.levels.medium) return "MEDIUM";
  return "LOW";
}

function factorPoints(weight: number, value: number, fullAt: number): number {
  if (fullAt <= 0) return 0;
  return Math.round(weight * clamp01(value / fullAt));
}

/**
 * Прозрачная формула v1: frequency + growth + authors + velocity.
 * Каждый фактор — целое число баллов, score = сумма факторов, clamp [0, 100].
 * `age` используется как признак достоверности velocity: без известного
 * времени первого упоминания скорость за окно не считается доверенной.
 */
export function calculateSignalScore(
  input: SignalInput,
  config: SignalScoringConfig = SIGNAL_CONFIG,
): SignalScore {
  const { factors: f } = config;
  const current = nonNegative(input.currentMentions);
  const previous = nonNegative(input.previousMentions);
  const authors = nonNegative(input.uniqueAuthors);
  const velocity = nonNegative(input.velocity);
  const age = nonNegative(input.age);

  const points: SignalFactors = {
    frequency: factorPoints(f.frequency.weight, current, f.frequency.fullAt),
    growth: factorPoints(
      f.growth.weight,
      Math.max(growthPercent(current, previous), 0),
      f.growth.fullAtPercent,
    ),
    authors: factorPoints(f.authors.weight, authors, f.authors.fullAt),
    velocity: age > 0 ? factorPoints(f.velocity.weight, velocity, f.velocity.fullAtPerHour) : 0,
  };

  const score = Math.min(
    Math.max(points.frequency + points.growth + points.authors + points.velocity, 0),
    100,
  );
  metrics.signalsCalculated += 1;

  return { score, level: resolveLevel(score, config), factors: points };
}
