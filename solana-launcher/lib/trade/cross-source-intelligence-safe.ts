import {
  buildCrossSourceChronology as buildBaseChronology,
  buildCrossSourceIndependence as buildBaseIndependence,
  buildCrossSourceIntelligence as buildBaseIntelligence,
  crossSourceSnapshotFeatures as buildBaseSnapshotFeatures,
  type CrossSourceChronology,
  type CrossSourceIntelligence,
  type SourceIndependence,
} from "./cross-source-intelligence";
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

export function crossSourceSnapshotFeatures(args: SafeCrossSourceArgs, observedAt: string) {
  return buildBaseSnapshotFeatures(sanitizeCrossSourceArgs(args), observedAt);
}
