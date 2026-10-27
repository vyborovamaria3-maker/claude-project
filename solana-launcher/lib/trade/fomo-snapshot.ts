import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULT_SOCIAL_OPTIONS,
  deriveSocialMetrics,
  toTimestamp,
  type SocialOptions,
  type SocialTimeline,
  type TwitterStats,
} from "./social-intelligence";
import type { FomoSnapshotRecord } from "./fomo-snapshot-store";

export const FOMO_SCORE_VERSION = "fomo-pressure-quality-v1";
export const FOMO_CAPTURE_BUCKET_MS = 15 * 60_000;

// Capture uses a fixed configuration so scores remain comparable across UI sessions.
// Bump FOMO_SCORE_VERSION whenever the formula or these source-query settings change.
export const FOMO_CAPTURE_OPTIONS: SocialOptions = {
  ...DEFAULT_SOCIAL_OPTIONS,
  symbol: "",
  lookback: "24",
  xLimit: 40,
  xVerifiedOnly: false,
  xExcludeSuspicious: true,
  tgLimit: 200,
  tgMinChannelScore: 0,
  tgExplicitCallsOnly: false,
};

type TwitterCapturePayload = TwitterStats & {
  lastUpdated?: number;
  collectionTruncated?: boolean;
  performance?: { cached?: boolean };
  meta?: TwitterStats["meta"] & {
    matchedBeforeLimit?: number;
    truncated?: boolean;
  };
};

type TelegramCapturePayload = SocialTimeline;

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record).sort().map((key) =>
    JSON.stringify(key) + ":" + stableStringify(record[key]),
  ).join(",") + "}";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;
}

function timestampList(values: Array<unknown>): number[] {
  return values.map(toTimestamp).filter((value): value is number => value != null);
}

function assertNoFutureEvents(x: TwitterCapturePayload, tg: TelegramCapturePayload, signalAt: number) {
  const xTimes = timestampList((x.topTweets || []).map((item) => item.timestamp));
  const tgTimes = timestampList((tg.timeline || []).map((item) => item.occurred_at));
  const metaTimes = timestampList([tg.meta?.firstMatchedAt, tg.meta?.lastMatchedAt]);
  if ([...xTimes, ...tgTimes, ...metaTimes].some((time) => time > signalAt)) {
    throw new TypeError("future_social_event");
  }
}

export function fomoCaptureBucketStart(signalAt: number): number {
  if (!Number.isSafeInteger(signalAt) || signalAt < 0) throw new TypeError("invalid_signal_at");
  return Math.floor(signalAt / FOMO_CAPTURE_BUCKET_MS) * FOMO_CAPTURE_BUCKET_MS;
}

export function buildFomoSnapshotRecord(args: {
  mint: string;
  x: unknown;
  tg: unknown;
  signalAt: number;
}): FomoSnapshotRecord {
  const { mint, signalAt } = args;
  if (typeof mint !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    throw new TypeError("invalid_mint");
  }
  if (!Number.isSafeInteger(signalAt) || signalAt <= 0 || signalAt > Date.now()) {
    throw new TypeError("invalid_signal_at");
  }

  const x = args.x as TwitterCapturePayload;
  const tg = args.tg as TelegramCapturePayload;
  if (
    !x || typeof x !== "object" || !Array.isArray(x.topTweets)
    || !x.aggregated || typeof x.aggregated !== "object"
    || !Number.isFinite(x.totalTweets) || !Number.isFinite(x.botRiskScore)
  ) {
    throw new TypeError("invalid_x_payload");
  }
  if (
    !tg || typeof tg !== "object" || !Array.isArray(tg.timeline)
    || !tg.platforms || typeof tg.platforms !== "object"
    || !Number.isFinite(tg.mentions)
  ) {
    throw new TypeError("invalid_telegram_payload");
  }

  assertNoFutureEvents(x, tg, signalAt);
  const rawLastUpdatedAt = x.lastUpdated;
  if (rawLastUpdatedAt != null && (!Number.isFinite(rawLastUpdatedAt) || rawLastUpdatedAt > signalAt)) {
    throw new TypeError("invalid_x_observed_at");
  }

  const derived = deriveSocialMetrics(
    x,
    tg,
    null,
    null,
    null,
    [],
    FOMO_CAPTURE_OPTIONS,
    signalAt,
  );
  if (
    !Number.isFinite(derived.fomoPressure)
    || !Number.isFinite(derived.fomoQuality)
    || !Number.isFinite(derived.fomoQualityCoverage)
  ) {
    throw new TypeError("invalid_fomo_score");
  }

  const xSampleCount = x.topTweets.length;
  const tgSampleCount = tg.timeline.length;
  const xMatchedCount = nonNegativeInteger(x.meta?.matchedBeforeLimit, nonNegativeInteger(x.totalTweets, xSampleCount));
  const tgMatchedCount = nonNegativeInteger(tg.meta?.matchedBeforeLimit, nonNegativeInteger(tg.mentions, tgSampleCount));
  const xTruncated = Boolean(
    x.collectionTruncated
    || x.meta?.truncated
    || xMatchedCount > xSampleCount,
  );
  const tgTruncated = Boolean(
    tg.meta?.truncated
    || tgMatchedCount > tgSampleCount,
  );

  // The API responses are bounded samples, not exhaustive platform history.
  // Never promote these snapshots to complete coverage based only on "not truncated".
  const xCoverage = "partial" as const;
  const tgCoverage = "partial" as const;
  const xLastUpdatedAt = rawLastUpdatedAt == null ? signalAt : rawLastUpdatedAt;
  const xEventTimes = timestampList(x.topTweets.map((item) => item.timestamp));
  const latestXEventAt = xEventTimes.length ? Math.max(...xEventTimes) : 0;
  const xObservedAt = xLastUpdatedAt >= latestXEventAt ? xLastUpdatedAt : signalAt;
  const tgObservedAt = signalAt;

  const xInputSha256 = sha256(stableStringify(x));
  const tgInputSha256 = sha256(stableStringify(tg));
  const captureConfig = {
    scoreVersion: FOMO_SCORE_VERSION,
    options: FOMO_CAPTURE_OPTIONS,
    sourceCoveragePolicy: "bounded_sample_is_partial",
  };
  const inputSha256 = sha256(stableStringify({
    mint,
    captureConfig,
    xInputSha256,
    tgInputSha256,
  }));
  const sourceMeta = {
    xLastUpdatedAt,
    xResponseCached: Boolean(x.performance?.cached),
    xSampleCount,
    xMatchedCount,
    xTruncated,
    tgSampleCount,
    tgMatchedCount,
    tgTruncated,
    tgFirstMatchedAt: tg.meta?.firstMatchedAt ?? null,
    tgLastMatchedAt: tg.meta?.lastMatchedAt ?? null,
    xObservedAt,
    tgResponseObservedAt: signalAt,
  };

  const recordBase: Omit<FomoSnapshotRecord, "snapshotSha256"> = {
    snapshotId: randomUUID(),
    canonicalTokenId: "solana:" + mint,
    mint,
    signalAt,
    maxInputObservedAt: Math.max(xObservedAt, tgObservedAt),
    bucketStartAt: fomoCaptureBucketStart(signalAt),
    scoreVersion: FOMO_SCORE_VERSION,
    fomoPressure: derived.fomoPressure,
    fomoQuality: derived.fomoQuality,
    qualityCoverage: derived.fomoQualityCoverage,
    xCoverage,
    tgCoverage,
    sourceCoverageKnownAt: signalAt,
    xObservedAt,
    tgObservedAt,
    xSampleCount,
    xMatchedCount,
    xTruncated: xTruncated ? 1 : 0,
    xCached: x.performance?.cached ? 1 : 0,
    tgSampleCount,
    tgMatchedCount,
    tgTruncated: tgTruncated ? 1 : 0,
    captureConfigJson: stableStringify(captureConfig),
    sourceMetaJson: stableStringify(sourceMeta),
    xInputSha256,
    tgInputSha256,
    inputSha256,
    createdAt: signalAt,
  };
  const snapshotSha256 = sha256(stableStringify(recordBase));
  return { ...recordBase, snapshotSha256 };
}

export function isSafeCaptureFailureCode(value: unknown): string {
  if (value instanceof Error && /^[a-z0-9_]{1,64}$/.test(value.message)) return value.message;
  return "capture_failed";
}
