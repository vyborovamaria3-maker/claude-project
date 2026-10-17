export type SignalOutcomeStatus =
  | "ready"
  | "pending"
  | "missing_entry"
  | "missing_exit"
  | "low_baseline";

export interface SignalQualityOutcome {
  signal_at: number | string;
  score: number | string;
  outcome_status: SignalOutcomeStatus | string;
  attention_change_pct: number | string | null;
}

export interface SignalQualityCohort {
  totalSignals: number;
  readyOutcomes: number;
  coveragePct: number | null;
  averageAttentionChangePct: number | null;
  medianAttentionChangePct: number | null;
  positiveAttentionRatePct: number | null;
}

export interface SignalQualityComparison {
  threshold: number;
  selected: SignalQualityCohort;
  baseline: SignalQualityCohort;
  averageChangeLiftPct: number | null;
  positiveRateLiftPct: number | null;
}

export interface SignalQualitySplit {
  train: SignalQualityOutcome[];
  test: SignalQualityOutcome[];
}

function finiteNumber(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function summarizeSignalQuality(rows: SignalQualityOutcome[]): SignalQualityCohort {
  const valid = rows
    .filter((row) => row.outcome_status === "ready")
    .map((row) => finiteNumber(row.attention_change_pct))
    .filter((value): value is number => value !== null);
  const medianValue = median(valid);

  return {
    totalSignals: rows.length,
    readyOutcomes: valid.length,
    coveragePct: rows.length > 0 ? round((valid.length / rows.length) * 100, 2) : null,
    averageAttentionChangePct: valid.length > 0
      ? round(valid.reduce((sum, value) => sum + value, 0) / valid.length, 4)
      : null,
    medianAttentionChangePct: medianValue === null ? null : round(medianValue, 4),
    positiveAttentionRatePct: valid.length > 0
      ? round((valid.filter((value) => value > 0).length / valid.length) * 100, 2)
      : null,
  };
}

export function compareSignalQuality(
  rows: SignalQualityOutcome[],
  threshold: number,
): SignalQualityComparison {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    throw new Error("threshold must be between 0 and 100");
  }

  const selected = rows.filter((row) => {
    const score = finiteNumber(row.score);
    return score !== null && score >= threshold;
  });
  const baseline = rows.filter((row) => {
    const score = finiteNumber(row.score);
    return score !== null && score < threshold;
  });
  const selectedSummary = summarizeSignalQuality(selected);
  const baselineSummary = summarizeSignalQuality(baseline);

  return {
    threshold,
    selected: selectedSummary,
    baseline: baselineSummary,
    averageChangeLiftPct: selectedSummary.averageAttentionChangePct === null
      || baselineSummary.averageAttentionChangePct === null
      ? null
      : round(selectedSummary.averageAttentionChangePct - baselineSummary.averageAttentionChangePct, 4),
    positiveRateLiftPct: selectedSummary.positiveAttentionRatePct === null
      || baselineSummary.positiveAttentionRatePct === null
      ? null
      : round(selectedSummary.positiveAttentionRatePct - baselineSummary.positiveAttentionRatePct, 2),
  };
}

export function splitSignalOutcomes(
  rows: SignalQualityOutcome[],
  splitAtMs: number,
): SignalQualitySplit {
  if (!Number.isFinite(splitAtMs)) throw new Error("splitAtMs must be a finite epoch timestamp");
  const train: SignalQualityOutcome[] = [];
  const test: SignalQualityOutcome[] = [];
  for (const row of rows) {
    const timestamp = finiteNumber(row.signal_at);
    if (timestamp === null) continue;
    if (timestamp < splitAtMs) train.push(row);
    else test.push(row);
  }
  return { train, test };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
