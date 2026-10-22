import { randomUUID, createHash } from "node:crypto";
import { parseTokenId, toUtcIso, type TokenId } from "@claude-project/contracts";
import type { PgTransaction } from "./entity-registry.js";

export type BacktestBaseline = "market_average" | "random";
export type BacktestObservation = Readonly<{
  canonicalTokenId: TokenId;
  signalAt: Date | string;
  maxInputObservedAt: Date | string;
  outcomeAt: Date | string;
  outcomeObservedAt: Date | string;
  score: number;
  outcome: boolean;
  outcomeValue?: number | null;
  evidenceRef?: string | null;
}>;
export type ValidatedBacktestObservation = BacktestObservation & {
  signalAt: string;
  maxInputObservedAt: string;
  outcomeAt: string;
  outcomeObservedAt: string;
  selected: boolean;
};
export type BacktestMetrics = Readonly<{
  sampleSize: number;
  selectedCount: number;
  selectedPositive: number;
  selectedNegative: number;
  baselineCount: number;
  baselinePositive: number;
  precision: number | null;
  recall: number | null;
  selectedRate: number | null;
  baselineRate: number | null;
  marketRate: number | null;
  uplift: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  pValue: number | null;
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  trueNegative: number;
  baselineKind: BacktestBaseline;
  threshold: number;
}>;

function normalCdf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}
function rate(positives: number, count: number): number | null {
  return count ? positives / count : null;
}
function wilsonInterval(positives: number, count: number): readonly [number, number] | null {
  if (!count) return null;
  const z = 1.96, p = positives / count, z2 = z * z;
  const denominator = 1 + z2 / count;
  const center = (p + z2 / (2 * count)) / denominator;
  const margin = z * Math.sqrt(p * (1 - p) / count + z2 / (4 * count * count)) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}
function differenceInterval(aPositives: number, aCount: number, bPositives: number, bCount: number): readonly [number, number] | null {
  const a = wilsonInterval(aPositives, aCount), b = wilsonInterval(bPositives, bCount);
  if (!a || !b) return null;
  const pa = aPositives / aCount, pb = bPositives / bCount, difference = pa - pb;
  const low = difference - Math.sqrt((pa - a[0]) ** 2 + (b[1] - pb) ** 2);
  const high = difference + Math.sqrt((a[1] - pa) ** 2 + (pb - b[0]) ** 2);
  return [Math.max(-1, low), Math.min(1, high)];
}
function twoProportionPValue(aPositives: number, aCount: number, bPositives: number, bCount: number): number | null {
  if (!aCount || !bCount) return null;
  const aRate = aPositives / aCount, bRate = bPositives / bCount;
  const pooled = (aPositives + bPositives) / (aCount + bCount);
  const standardError = Math.sqrt(pooled * (1 - pooled) * (1 / aCount + 1 / bCount));
  if (standardError === 0) return aRate === bRate ? 1 : null;
  const correction = 0.5 * (1 / aCount + 1 / bCount);
  const z = Math.max(0, Math.abs(aRate - bRate) - correction) / standardError;
  return Math.max(0, Math.min(1, 2 * (1 - normalCdf(z))));
}
function seededOrder(row: ValidatedBacktestObservation, seed: string): string {
  return createHash("sha256").update(seed + "|" + row.canonicalTokenId + "|" + row.signalAt).digest("hex");
}

export function runSignalBacktest(
  observations: readonly BacktestObservation[],
  options: Readonly<{ threshold: number; baseline?: BacktestBaseline; seed?: string }>,
): { runId: string; metrics: BacktestMetrics; observations: ValidatedBacktestObservation[] } {
  if (!Number.isFinite(options.threshold)) throw new TypeError("Backtest threshold must be finite");
  const baselineKind = options.baseline ?? "market_average";
  if (baselineKind !== "market_average" && baselineKind !== "random") throw new TypeError("Invalid baseline");
  const validated: ValidatedBacktestObservation[] = observations.map((row) => {
    if (parseTokenId(row.canonicalTokenId)?.id !== row.canonicalTokenId) throw new TypeError("Noncanonical backtest token ID");
    if (typeof row.score !== "number" || !Number.isFinite(row.score)) throw new TypeError("Backtest score must be finite");
    const signalAt = toUtcIso(row.signalAt);
    const maxInputObservedAt = toUtcIso(row.maxInputObservedAt);
    const outcomeAt = toUtcIso(row.outcomeAt);
    const outcomeObservedAt = toUtcIso(row.outcomeObservedAt);
    if (maxInputObservedAt > signalAt) throw new TypeError("Look-ahead bias: feature observed after signal");
    if (outcomeAt <= signalAt) throw new TypeError("Outcome must occur after the signal");
    if (outcomeObservedAt < outcomeAt) throw new TypeError("Outcome cannot be observed before it occurs");
    if (typeof row.outcome !== "boolean") throw new TypeError("Outcome label must be boolean");
    if (row.outcomeValue !== undefined && row.outcomeValue !== null &&
        (typeof row.outcomeValue !== "number" || !Number.isFinite(row.outcomeValue))) {
      throw new TypeError("Outcome value must be finite or null");
    }
    return { ...row, signalAt, maxInputObservedAt, outcomeAt, outcomeObservedAt, selected: row.score >= options.threshold };
  });
  const selected = validated.filter((row) => row.selected);
  const unselected = validated.filter((row) => !row.selected);
  const positives = validated.filter((row) => row.outcome).length;
  const selectedPositive = selected.filter((row) => row.outcome).length;
  const selectedNegative = selected.length - selectedPositive;
  const unselectedPositive = unselected.filter((row) => row.outcome).length;
  const selectedRate = rate(selectedPositive, selected.length);
  const marketRate = rate(positives, validated.length);
  let baseline = unselected;
  if (baselineKind === "random") {
    const count = selected.length;
    // A random market baseline must include the full eligible population.
    baseline = [...validated].sort((a, b) =>
      seededOrder(a, options.seed ?? "cross-platform-backtest-v1").localeCompare(
        seededOrder(b, options.seed ?? "cross-platform-backtest-v1"),
      )).slice(0, count);
  }
  const baselineCount = baselineKind === "market_average" ? validated.length : baseline.length;
  const baselinePositive = baselineKind === "market_average" ? positives : baseline.filter((row) => row.outcome).length;
  const baselineRate = baselineKind === "market_average" ? marketRate : rate(baselinePositive, baseline.length);
  const uplift = selectedRate === null || baselineRate === null ? null : selectedRate - baselineRate;
  let ciLow: number | null = null, ciHigh: number | null = null, pValue: number | null = null;
  const independentTokens = new Set(validated.map((row) => row.canonicalTokenId)).size === validated.length;
  // Random market controls can overlap selected observations; repeated tokens are not independent.
  if (selectedRate !== null && independentTokens && baselineKind === "market_average") {
    if (baselineKind === "market_average") {
      const interval = differenceInterval(selectedPositive, selected.length, unselectedPositive, unselected.length);
      const scale = validated.length ? unselected.length / validated.length : 0;
      if (interval && rate(unselectedPositive, unselected.length) !== null) {
        ciLow = interval[0] * scale; ciHigh = interval[1] * scale;
        pValue = twoProportionPValue(selectedPositive, selected.length, unselectedPositive, unselected.length);
      }
    } else {
      const interval = differenceInterval(selectedPositive, selected.length, baselinePositive, baseline.length);
      if (interval) { ciLow = interval[0]; ciHigh = interval[1]; pValue = twoProportionPValue(selectedPositive, selected.length, baselinePositive, baseline.length); }
    }
  }
  const truePositive = selectedPositive;
  const falsePositive = selectedNegative;
  const falseNegative = validated.filter((row) => !row.selected && row.outcome).length;
  const trueNegative = validated.filter((row) => !row.selected && !row.outcome).length;
  return {
    runId: randomUUID(),
    metrics: {
      sampleSize: validated.length,
      selectedCount: selected.length,
      selectedPositive,
      selectedNegative,
      baselineCount,
      baselinePositive,
      precision: selectedRate,
      recall: positives ? selectedPositive / positives : null,
      selectedRate,
      baselineRate,
      marketRate,
      uplift,
      ciLow,
      ciHigh,
      pValue,
      truePositive,
      falsePositive,
      falseNegative,
      trueNegative,
      baselineKind,
      threshold: options.threshold,
    },
    observations: validated,
  };
}

export async function persistBacktestRun(
  tx: PgTransaction,
  input: Readonly<{
    runId: string;
    signalName: string;
    outcomeKind: string;
    fromAt: Date | string;
    toAt: Date | string;
    horizonHours: number;
    threshold: number;
    baselineKind: BacktestBaseline;
    metrics: BacktestMetrics;
    observations: readonly ValidatedBacktestObservation[];
    dataCutoffAt: Date | string;
    featureVersion?: string | null;
    modelId?: string | null;
  }>,
): Promise<void> {
  const fromAt = toUtcIso(input.fromAt);
  const toAt = toUtcIso(input.toAt);
  const dataCutoffAt = toUtcIso(input.dataCutoffAt);
  if (fromAt >= toAt || dataCutoffAt < toAt) throw new TypeError("Invalid backtest date range or cutoff");
  if (!Number.isSafeInteger(input.horizonHours) || input.horizonHours < 1 || input.horizonHours > 720) {
    throw new TypeError("Invalid backtest horizon");
  }
  if(input.metrics.sampleSize!==input.observations.length)throw new TypeError("Backtest metrics sample count mismatch");
  for(const row of input.observations){
    const signalAt=toUtcIso(row.signalAt),featureAt=toUtcIso(row.maxInputObservedAt);
    const outcomeAt=toUtcIso(row.outcomeAt),observedAt=toUtcIso(row.outcomeObservedAt);
    const horizonEnd=new Date(Date.parse(signalAt)+input.horizonHours*3_600_000).toISOString();
    if(signalAt<fromAt||signalAt>toAt||featureAt>signalAt||outcomeAt<=signalAt||
       outcomeAt>horizonEnd||observedAt<outcomeAt||observedAt>dataCutoffAt||
       horizonEnd>dataCutoffAt)throw new TypeError("Backtest result violates as-of or completed-horizon constraints");
  }
  const startedAt = new Date().toISOString();
  const completedAt = new Date().toISOString();
  if (dataCutoffAt > completedAt) throw new TypeError("Backtest data cutoff cannot be in the future");
  await tx.query(`INSERT INTO backtest_runs
    (run_id,signal_name,outcome_kind,from_at,to_at,horizon_hours,threshold,baseline_kind,status,
     metrics,feature_version,model_id,started_at,completed_at,data_cutoff_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'completed',$9::jsonb,$10,$11,$12,$13,$14)`, [
    input.runId,input.signalName,input.outcomeKind,fromAt,toAt,input.horizonHours,input.threshold,
    input.baselineKind,JSON.stringify(input.metrics),input.featureVersion ?? null,input.modelId ?? null,
    startedAt,completedAt,dataCutoffAt,
  ]);
  for (const row of input.observations) {
    await tx.query(`INSERT INTO backtest_results
      (run_id,canonical_token_id,signal_at,max_input_observed_at,outcome_at,outcome_observed_at,
       score,outcome_label,selected,outcome_value,evidence_ref)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [
      input.runId,row.canonicalTokenId,row.signalAt,row.maxInputObservedAt,row.outcomeAt,row.outcomeObservedAt,
      row.score,row.outcome,row.selected,row.outcomeValue ?? null,row.evidenceRef ?? null,
    ]);
  }
}
