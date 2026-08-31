import {
  buildCrossSourceChronology as buildBaseChronology,
  buildCrossSourceIndependence as buildBaseIndependence,
  buildCrossSourceIntelligence as buildBaseIntelligence,
  crossSourceSnapshotFeatures as buildBaseSnapshotFeatures,
  type CrossSourceChronology,
  type CrossSourceIntelligence,
  type SourceIndependence,
} from "./cross-source-intelligence";
import {
  firstCallerReputation,
  telegramTokenIntelligence,
} from "./telegram-intelligence-view";
import type {
  ChainAnalysis,
  DerivedSocial,
  Market,
  SocialTimeline,
  TwitterStats,
} from "./social-intelligence";

export type SafeCrossSourceArgs = {
  x: TwitterStats | null;
  telegram: SocialTimeline | null;
  chain: ChainAnalysis | null;
  market: Market | null;
  derived: DerivedSocial;
};

function stripNulls<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripNulls(item)) as T;
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = item === null ? undefined : stripNulls(item);
    }
    return output as T;
  }
  return value;
}

export function sanitizeCrossSourceArgs(args: SafeCrossSourceArgs): SafeCrossSourceArgs {
  // The base deterministic layer converts values with Number(...). JavaScript maps null to 0,
  // which would turn unknown bot/market/Telegram values into real zeros. Preserve unknown as
  // undefined before the base calculations so Number(undefined) stays NaN and is treated missing.
  return stripNulls(args);
}

function normalizeChronology(chronology: CrossSourceChronology): CrossSourceChronology {
  return {
    ...chronology,
    // UI chronology coverage is timestamp coverage. A current-state breakout without an exact
    // timestamp is still "observed", but must not be displayed as an orderable chronology stage.
    observedStages: chronology.orderableStages,
  };
}

export function buildSourceIndependence(args: SafeCrossSourceArgs): SourceIndependence {
  return buildBaseIndependence(sanitizeCrossSourceArgs(args));
}

export function buildCrossSourceChronology(args: SafeCrossSourceArgs): CrossSourceChronology {
  return normalizeChronology(buildBaseChronology(sanitizeCrossSourceArgs(args)));
}

export function buildCrossSourceIntelligence(args: SafeCrossSourceArgs): CrossSourceIntelligence {
  const safe = sanitizeCrossSourceArgs(args);
  const value = buildBaseIntelligence(safe);
  return {
    ...value,
    chronology: normalizeChronology(value.chronology),
  };
}

function temporalCallerSnapshotFeatures(args: SafeCrossSourceArgs, observedAt: string) {
  const caller = firstCallerReputation(telegramTokenIntelligence(args.telegram));
  if (!caller) return [];
  const rows: Array<{
    key: string;
    group: string;
    label: string;
    value: number | null;
    numericValue: number | null;
    source: "telegram";
    confidence: number;
    observedAt: string;
    missing: boolean;
    note: string;
  }> = [];
  const add = (key: string, label: string, value: number | null, confidence: number, note: string) => {
    rows.push({
      key,
      group: "Telegram caller temporal outcomes",
      label,
      value,
      numericValue: value,
      source: "telegram",
      confidence: value == null ? 0 : confidence,
      observedAt,
      missing: value == null,
      note,
    });
  };

  add(
    "telegram.first_caller_temporal_outcome_score",
    "First caller temporal outcome score",
    caller.temporalOutcomeScore,
    0.64,
    "Historical 15m/1h/4h/24h caller outcome composite. It is descriptive historical evidence, not a probability of this token rising.",
  );
  for (const label of ["15m", "1h", "4h", "24h"]) {
    const window = caller.outcomeWindows[label];
    if (!window || window.samples <= 0) continue;
    add(
      `telegram.first_caller_${label}_median_close_multiple`,
      `First caller ${label} median close multiple`,
      window.medianCloseMultiple,
      0.7,
      `Median historical close multiple at ${label} across ${window.samples} complete outcome windows.`,
    );
    add(
      `telegram.first_caller_${label}_positive_close_rate`,
      `First caller ${label} positive close rate`,
      window.positiveCloseRate,
      0.68,
      `Historical fraction of complete ${label} windows closing above the call baseline; not a forecast probability.`,
    );
    add(
      `telegram.first_caller_${label}_two_x_rate`,
      `First caller ${label} 2x peak rate`,
      window.twoXRate,
      0.66,
      `Historical fraction of complete ${label} windows whose observed peak reached at least 2x; not a forecast probability.`,
    );
  }
  return rows;
}

export function crossSourceSnapshotFeatures(args: SafeCrossSourceArgs, observedAt: string) {
  const safe = sanitizeCrossSourceArgs(args);
  return [
    ...buildBaseSnapshotFeatures(safe, observedAt),
    ...temporalCallerSnapshotFeatures(safe, observedAt),
  ];
}
