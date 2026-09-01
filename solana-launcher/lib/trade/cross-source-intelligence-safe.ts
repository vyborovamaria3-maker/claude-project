import {
  buildCrossSourceChronology as buildBaseChronology,
  buildSourceIndependence as buildBaseIndependence,
  buildCrossSourceIntelligence as buildBaseIntelligence,
  crossSourceSnapshotFeatures as buildBaseSnapshotFeatures,
  type ChronologyStageKey,
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

const RELIABLE_CHRONOLOGY_CONFIDENCE = 0.60;

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

function timestampNote(timestamp: number | null) {
  if (timestamp == null || !Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString().replace("T", " ").replace(".000Z", " UTC");
}

function minutesBetween(left: number | null, right: number | null) {
  if (left == null || right == null) return null;
  return Number(((right - left) / 60_000).toFixed(2));
}

function normalizeChronology(
  chronology: CrossSourceChronology,
  args: SafeCrossSourceArgs,
): CrossSourceChronology {
  const stages = chronology.stages.map((stage) => {
    let confidence = stage.confidence;
    const notes = [stage.note];
    if (stage.key === "x_acceleration") {
      if (args.x?.meta?.queryMode === "top") {
        confidence = Math.min(confidence, 0.49);
        notes.push("X queryMode=top не является надёжной хронологической выборкой.");
      }
      if (args.x?.meta?.truncated) {
        confidence = Math.min(confidence, 0.55);
        notes.push("X chronology исключена из entry-order scoring из-за truncated sample.");
      }
    }
    const reliable = stage.timestamp != null
      && Number.isFinite(stage.timestamp)
      && confidence >= RELIABLE_CHRONOLOGY_CONFIDENCE;
    const dated = timestampNote(stage.timestamp);
    if (dated) notes.push(`Timestamp: ${dated}.`);
    if (stage.timestamp != null && !reliable) {
      notes.push(
        `Timestamp виден как контекст, но не влияет на Entry Timing: confidence ${Math.round(confidence * 100)}% < ${Math.round(RELIABLE_CHRONOLOGY_CONFIDENCE * 100)}%.`,
      );
    }
    return {
      ...stage,
      confidence,
      observed: reliable,
      note: notes.filter(Boolean).join(" "),
    };
  });

  const reliableTime = (key: ChronologyStageKey) => {
    const stage = stages.find((item) => item.key === key);
    return stage?.observed && stage.timestamp != null ? stage.timestamp : null;
  };
  let comparablePairs = 0;
  let correctPairs = 0;
  for (let index = 0; index < stages.length - 1; index += 1) {
    const left = stages[index];
    const right = stages[index + 1];
    if (!left.observed || !right.observed || left.timestamp == null || right.timestamp == null) continue;
    comparablePairs += 1;
    if (left.timestamp <= right.timestamp) correctPairs += 1;
  }

  const reliable = stages.filter(
    (stage) => stage.observed && stage.timestamp != null,
  );
  const coverage = Number(((reliable.length / stages.length) * 100).toFixed(1));
  const alignmentScore = comparablePairs
    ? Number(((correctPairs / comparablePairs) * 100).toFixed(1))
    : null;
  const smartTime = reliableTime("smart_wallet");
  const telegramTime = reliableTime("telegram_caller");
  const xTime = reliableTime("x_acceleration");
  const marketTime = reliableTime("market_breakout");
  const socialTimes = [telegramTime, xTime].filter((value): value is number => value != null);
  const firstSocial = socialTimes.length ? Math.min(...socialTimes) : null;
  const priceLedSocial = marketTime != null && firstSocial != null && marketTime < firstSocial;
  const observedLabels = reliable
    .slice()
    .sort((left, right) => Number(left.timestamp) - Number(right.timestamp))
    .map((stage) => stage.label);
  const summary = observedLabels.length >= 2
    ? `${observedLabels.join(" → ")}. Reliable chronology coverage ${Math.round(coverage)}%${alignmentScore == null ? "" : `; canonical-order alignment ${Math.round(alignmentScore)}%`}.`
    : "Недостаточно надёжных timestamp-источников для устойчивой cross-source chronology.";

  return {
    ...chronology,
    stages,
    observedStages: reliable.length,
    orderableStages: reliable.length,
    coverage,
    alignmentScore,
    walletToTelegramMinutes: minutesBetween(smartTime, telegramTime),
    telegramToXMinutes: minutesBetween(telegramTime, xTime),
    xToMarketMinutes: minutesBetween(xTime, marketTime),
    priceLedSocial,
    summary,
  };
}

export function buildSourceIndependence(args: SafeCrossSourceArgs): SourceIndependence {
  return buildBaseIndependence(sanitizeCrossSourceArgs(args));
}

export function buildCrossSourceChronology(args: SafeCrossSourceArgs): CrossSourceChronology {
  const safe = sanitizeCrossSourceArgs(args);
  return normalizeChronology(buildBaseChronology(safe), safe);
}

export function buildCrossSourceIntelligence(args: SafeCrossSourceArgs): CrossSourceIntelligence {
  const safe = sanitizeCrossSourceArgs(args);
  const value = buildBaseIntelligence(safe);
  return {
    ...value,
    chronology: normalizeChronology(value.chronology, safe),
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
    "Historical 15m/1h/4h/24h caller outcome composite excluding the current mint. It is descriptive historical evidence, not a probability of this token rising.",
  );
  for (const label of ["15m", "1h", "4h", "24h"]) {
    const window = caller.outcomeWindows[label];
    if (!window || window.samples <= 0) continue;
    add(
      `telegram.first_caller_${label}_median_close_multiple`,
      `First caller ${label} median close multiple`,
      window.medianCloseMultiple,
      0.7,
      `Median historical close multiple at ${label} across ${window.samples} complete outcome windows, excluding the current mint.`,
    );
    add(
      `telegram.first_caller_${label}_positive_close_rate`,
      `First caller ${label} positive close rate`,
      window.positiveCloseRate,
      0.68,
      `Historical fraction of complete ${label} windows closing above the call baseline; current mint excluded; not a forecast probability.`,
    );
    add(
      `telegram.first_caller_${label}_two_x_rate`,
      `First caller ${label} 2x peak rate`,
      window.twoXRate,
      0.66,
      `Historical fraction of complete ${label} windows whose observed peak reached at least 2x; current mint excluded; not a forecast probability.`,
    );
  }
  return rows;
}

function replaceChronologySnapshotValues<T extends { key: string; value: unknown; numericValue: number | null; missing: boolean; confidence: number }>(
  rows: T[],
  chronology: CrossSourceChronology,
): T[] {
  const replacements: Record<string, number | null> = {
    "cross_source.chronology_coverage": chronology.coverage,
    "cross_source.chronology_alignment": chronology.alignmentScore,
    "cross_source.wallet_to_telegram_minutes": chronology.walletToTelegramMinutes,
    "cross_source.telegram_to_x_minutes": chronology.telegramToXMinutes,
    "cross_source.x_to_market_minutes": chronology.xToMarketMinutes,
    "cross_source.price_led_social": chronology.orderableStages >= 2
      ? (chronology.priceLedSocial ? 1 : 0)
      : null,
  };
  return rows.map((row) => {
    if (!(row.key in replacements)) return row;
    const value = replacements[row.key];
    return {
      ...row,
      value,
      numericValue: value,
      missing: value == null,
      confidence: value == null ? 0 : row.confidence,
    };
  });
}

export function crossSourceSnapshotFeatures(args: SafeCrossSourceArgs, observedAt: string) {
  const safe = sanitizeCrossSourceArgs(args);
  const chronology = buildCrossSourceChronology(safe);
  const base = buildBaseSnapshotFeatures(safe, observedAt);
  return [
    ...replaceChronologySnapshotValues(base, chronology),
    ...temporalCallerSnapshotFeatures(safe, observedAt),
  ];
}
