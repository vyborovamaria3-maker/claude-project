import { metrics } from "../../core/metrics";
import { PRIORITY_CONFIG, type PriorityConfig } from "./config";
import type { SignalLevel } from "./scorer";
import type { WeightedTrend } from "./weighted-scorer";

/**
 * Priority layer v2: приоритет сигнала = уровень weighted-сигнала + качество
 * источника (KOL) + динамика (growth). Ничего не пишет в БД.
 *
 * CRITICAL + KOL → URGENT
 * CRITICAL        → IMPORTANT
 * HIGH + KOL      → IMPORTANT
 * HIGH + growth   → IMPORTANT
 * HIGH / MEDIUM   → NORMAL
 * LOW             → LOW
 */

export type Priority = "LOW" | "NORMAL" | "IMPORTANT" | "URGENT";

export interface PriorityInput {
  /** Уровень weighted-сигнала (v2). */
  level: SignalLevel;
  /** Influence Score KOL-автора; 0 / undefined — KOL нет. */
  kolInfluence?: number;
  /** Тренд: направление либо рост в % от предыдущего окна. */
  trend?: WeightedTrend;
}

export interface PriorityResult {
  priority: Priority;
  reason: string;
}

/** Growth-признак: rising либо рост >= порога (PRIORITY_CONFIG.growthPercent). */
export function isGrowthSignal(
  trend: WeightedTrend | undefined,
  config: PriorityConfig = PRIORITY_CONFIG,
): boolean {
  if (trend === undefined) return false;
  if (typeof trend === "number") {
    return Number.isFinite(trend) && trend >= config.growthPercent;
  }
  return trend === "rising";
}

export function calculatePriority(
  input: PriorityInput,
  config: PriorityConfig = PRIORITY_CONFIG,
): PriorityResult {
  const rawInfluence = input.kolInfluence;
  const kolInfluence = typeof rawInfluence === "number" && Number.isFinite(rawInfluence)
    ? rawInfluence
    : 0;
  const isKol = kolInfluence >= config.kolThreshold;
  const growth = isGrowthSignal(input.trend, config);

  let result: PriorityResult;
  if (input.level === "CRITICAL" && isKol) {
    result = { priority: "URGENT", reason: "CRITICAL signal + KOL" };
  } else if (input.level === "CRITICAL") {
    result = { priority: "IMPORTANT", reason: "CRITICAL signal" };
  } else if (input.level === "HIGH" && isKol) {
    result = { priority: "IMPORTANT", reason: "HIGH signal + KOL" };
  } else if (input.level === "HIGH" && growth) {
    result = { priority: "IMPORTANT", reason: "HIGH signal + growth" };
  } else if (input.level === "HIGH") {
    result = { priority: "NORMAL", reason: "HIGH signal" };
  } else if (input.level === "MEDIUM") {
    result = { priority: "NORMAL", reason: "MEDIUM signal" };
  } else {
    result = { priority: "LOW", reason: "LOW signal" };
  }

  metrics.prioritySignalsCreated += 1;
  return result;
}
