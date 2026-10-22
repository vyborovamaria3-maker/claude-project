import { createHash } from "node:crypto";
import { parseTokenId, toUtcIso, type TokenId } from "@claude-project/contracts";
import type { PgTransaction } from "./entity-registry.js";

export const CROSS_PLATFORM_SCORE_VERSION = "cross-platform-heuristics-v2";

export type SourceSystem = "tg" | "x" | "blockchain";
export type CoverageStatus = "complete" | "partial" | "unknown";
export type CoverageScope = "timeline_events" | "token_swap_evidence_revisions" | "settled_trade_tape";
type NullableNumber = number | null;

export type CrossPlatformSnapshotInput = Readonly<{
  canonicalTokenId: TokenId;
  day: string;
  asOf: Date | string;
  maxInputObservedAt: Date | string;
  tgMentions: NullableNumber;
  tgUniqueAuthors: NullableNumber;
  tgCopypastaRatio: NullableNumber;
  tgSentimentScore: NullableNumber;
  tgScamRatio: NullableNumber;
  xMentions: NullableNumber;
  xUniqueAuthors: NullableNumber;
  xBotRatio: NullableNumber;
  xSentimentScore: NullableNumber;
  chainTrades: NullableNumber;
  chainTransactions: NullableNumber;
  chainSwapEvidenceCount: NullableNumber;
  chainUniqueWallets: NullableNumber;
  chainVolumeUsd: NullableNumber;
  chainLiquidityUsd: NullableNumber;
  chainSmartMoneyBought: NullableNumber;
  chainRugRisk: NullableNumber;
  tgMentionsZ1h?: NullableNumber;
  xMentionsZ1h?: NullableNumber;
  chainVolumeZ1h?: NullableNumber;
  firstMentionTgAt?: Date | string | null;
  firstMentionXAt?: Date | string | null;
  firstTradeAt?: Date | string | null;
  firstSwapEvidenceAt?: Date | string | null;
  sourceCoverage?: Readonly<Record<SourceSystem, CoverageStatus>>;
}>;

export type CrossPlatformScores = Readonly<{
  attentionScore: number | null;
  credibilityScore: number | null;
  riskScore: number | null;
  momentumScore: number | null;
  dataConfidence: number;
  scoreVersion: typeof CROSS_PLATFORM_SCORE_VERSION;
  scoreReason: Record<string, unknown>;
}>;

export type ValidatedCrossPlatformSnapshot = CrossPlatformSnapshotInput & CrossPlatformScores & {
  asOf: string;
  maxInputObservedAt: string;
  firstMentionTgAt: string | null;
  firstMentionXAt: string | null;
  firstTradeAt: string | null;
  firstSwapEvidenceAt: string | null;
  sourceCoverage: Record<SourceSystem, CoverageStatus>;
  snapshotSha256: string;
};

const RAW_FIELDS = [
  "tgMentions", "tgUniqueAuthors", "tgCopypastaRatio", "tgSentimentScore", "tgScamRatio",
  "xMentions", "xUniqueAuthors", "xBotRatio", "xSentimentScore", "chainTrades", "chainTransactions", "chainSwapEvidenceCount",
  "chainUniqueWallets", "chainVolumeUsd", "chainLiquidityUsd", "chainSmartMoneyBought", "chainRugRisk",
] as const;

function finiteOrNull(value: unknown, min: number, max: number): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max);
}
function countOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}
function ratioOrNull(value: unknown): value is number | null {
  return finiteOrNull(value, 0, 1);
}
function utcOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return toUtcIso(value);
}
function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return "{" + Object.keys(object).sort().map((key) => JSON.stringify(key) + ":" + stableJson(object[key])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}
function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function timestamp(value: unknown): Date | string {
  if (value instanceof Date || typeof value === "string") return value;
  throw new TypeError("Invalid stored timestamp");
}
function timestampOrNull(value: unknown): Date | string | null {
  if (value === null || value === undefined) return null;
  return timestamp(value);
}

export function computeCrossPlatformScores(input: CrossPlatformSnapshotInput): CrossPlatformScores {
  const attentionParts: Array<[string, number | null, number]> = [
    ["tg_mentions", input.tgMentions, 0.4],
    ["x_mentions", input.xMentions, 0.35],
    ["chain_swap_evidence_count", input.chainSwapEvidenceCount, 0.25],
  ];
  const attentionAvailable = attentionParts.filter(([, value]) => value !== null);
  const attentionScore = attentionAvailable.length
    ? attentionAvailable.reduce((sum, [, value, weight]) => sum + Math.log1p(value!) * weight, 0)
    : null;

  const availableRaw = RAW_FIELDS.filter((field) => input[field] !== null);
  const dataConfidence = availableRaw.length / RAW_FIELDS.length;

  const credibilityScore = input.tgCopypastaRatio !== null && input.xBotRatio !== null
    ? Math.max(0, Math.min(1, (1 - input.tgCopypastaRatio) * (1 - input.xBotRatio) * (0.5 + 0.5 * dataConfidence)))
    : null;

  const riskParts: Array<[string, number | null, number]> = [
    ["chain_rug_risk", input.chainRugRisk, 0.6],
    ["tg_scam_ratio", input.tgScamRatio, 0.2],
    ["x_bot_ratio", input.xBotRatio, 0.2],
  ];
  const riskAvailable = riskParts.filter(([, value]) => value !== null);
  const riskWeight = riskAvailable.reduce((sum, [, , weight]) => sum + weight, 0);
  const riskScore = riskWeight > 0
    ? riskAvailable.reduce((sum, [, value, weight]) => sum + value! * weight, 0) / riskWeight
    : null;

  const momentumParts: Array<[string, number | null, number]> = [
    ["tg_mentions_z_1h", input.tgMentionsZ1h ?? null, 0.4],
    ["x_mentions_z_1h", input.xMentionsZ1h ?? null, 0.3],
    ["chain_volume_z_1h", input.chainVolumeZ1h ?? null, 0.3],
  ];
  const momentumAvailable = momentumParts.filter(([, value]) => value !== null);
  const momentumScore = momentumAvailable.length
    ? momentumAvailable.reduce((sum, [, value, weight]) => sum + value! * weight, 0)
    : null;

  return {
    attentionScore,
    credibilityScore,
    riskScore,
    momentumScore,
    dataConfidence,
    scoreVersion: CROSS_PLATFORM_SCORE_VERSION,
    scoreReason: {
      attention: { used: attentionAvailable.map(([name]) => name), missing: attentionParts.filter(([, value]) => value === null).map(([name]) => name) },
      credibility: { used: credibilityScore === null ? [] : ["tg_copypasta_ratio", "x_bot_ratio", "data_confidence"] },
      risk: { used: riskAvailable.map(([name]) => name), missing: riskParts.filter(([, value]) => value === null).map(([name]) => name) },
      momentum: { used: momentumAvailable.map(([name]) => name), missing: momentumParts.filter(([, value]) => value === null).map(([name]) => name) },
      heuristic: true,
      predictiveValidity: "not_established_until_out_of_sample_backtest",
    },
  };
}

export function validateCrossPlatformSnapshot(input: CrossPlatformSnapshotInput): ValidatedCrossPlatformSnapshot {
  if (parseTokenId(input.canonicalTokenId)?.id !== input.canonicalTokenId) throw new TypeError("Noncanonical token ID");
  if (typeof input.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.day) ||
      new Date(input.day + "T00:00:00.000Z").toISOString().slice(0, 10) !== input.day) {
    throw new TypeError("Invalid UTC day");
  }
  const asOf = toUtcIso(input.asOf);
  const maxInputObservedAt = toUtcIso(input.maxInputObservedAt);
  if (asOf < input.day + "T00:00:00.000Z") throw new TypeError("Snapshot as_of cannot precede the UTC day");
  if (maxInputObservedAt > asOf) throw new TypeError("Future-observed inputs are not allowed");
  const counts = ["tgMentions", "tgUniqueAuthors", "xMentions", "xUniqueAuthors", "chainTrades", "chainTransactions", "chainSwapEvidenceCount", "chainUniqueWallets", "chainSmartMoneyBought"] as const;
  for (const key of counts) if (!countOrNull(input[key])) throw new TypeError("Invalid count: " + key);
  const ratios = ["tgCopypastaRatio", "tgScamRatio", "xBotRatio", "chainRugRisk"] as const;
  for (const key of ratios) if (!ratioOrNull(input[key])) throw new TypeError("Invalid ratio: " + key);
  for (const key of ["tgSentimentScore", "xSentimentScore"] as const) {
    if (!finiteOrNull(input[key], -1, 1)) throw new TypeError("Invalid sentiment score: " + key);
  }
  for (const key of ["chainVolumeUsd", "chainLiquidityUsd"] as const) {
    if (!finiteOrNull(input[key], 0, Number.MAX_VALUE)) throw new TypeError("Invalid nonnegative amount: " + key);
  }
  for (const key of ["tgMentionsZ1h", "xMentionsZ1h", "chainVolumeZ1h"] as const) {
    const value = input[key];
    if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new TypeError("Invalid z-score: " + key);
    }
  }
  const firstMentionTgAt = utcOrNull(input.firstMentionTgAt);
  const firstMentionXAt = utcOrNull(input.firstMentionXAt);
  const firstTradeAt = utcOrNull(input.firstTradeAt);
  const firstSwapEvidenceAt = utcOrNull(input.firstSwapEvidenceAt);
  for (const value of [firstMentionTgAt, firstMentionXAt, firstTradeAt, firstSwapEvidenceAt]) {
    if (value !== null && value > asOf) throw new TypeError("Event time cannot be in the future");
  }
  const scores = computeCrossPlatformScores(input);
  const sourceCoverage: Record<SourceSystem, CoverageStatus> = {
    tg: input.sourceCoverage?.tg ?? (input.tgMentions === null ? "unknown" : "partial"),
    x: input.sourceCoverage?.x ?? (input.xMentions === null ? "unknown" : "partial"),
    blockchain: input.sourceCoverage?.blockchain ?? (input.chainTransactions === null && input.chainSwapEvidenceCount === null && input.chainTrades === null ? "unknown" : "partial"),
  };
  const normalized = {
    ...input,
    tgMentionsZ1h: input.tgMentionsZ1h ?? null,
    xMentionsZ1h: input.xMentionsZ1h ?? null,
    chainVolumeZ1h: input.chainVolumeZ1h ?? null,
    asOf, maxInputObservedAt, firstMentionTgAt, firstMentionXAt, firstTradeAt, firstSwapEvidenceAt,
    ...scores, sourceCoverage,
  };
  return { ...normalized, snapshotSha256: sha256(stableJson(normalized)) };
}

export async function putCrossPlatformSnapshot(
  tx: PgTransaction, input: CrossPlatformSnapshotInput,
): Promise<ValidatedCrossPlatformSnapshot> {
  const x = validateCrossPlatformSnapshot(input);
  const result = await tx.query(`INSERT INTO token_daily_cross_platform (
    canonical_token_id,day,as_of,max_input_observed_at,
    tg_mentions,tg_unique_authors,tg_copypasta_ratio,tg_sentiment_score,tg_scam_ratio,
    x_mentions,x_unique_authors,x_bot_ratio,x_sentiment_score,
    chain_trades,chain_transactions,chain_swap_evidence_count,chain_unique_wallets,chain_volume_usd,chain_liquidity_usd,chain_smart_money_bought,chain_rug_risk,
    tg_mentions_z_1h,x_mentions_z_1h,chain_volume_z_1h,
    first_mention_tg_at,first_mention_x_at,first_trade_at,first_swap_evidence_at,
    attention_score,credibility_score,risk_score,momentum_score,score_version,score_reason,
    source_coverage,data_confidence,snapshot_sha256
  ) VALUES (
    $1,$2::date,$3,$4,
    $5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
    $22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34::jsonb,$35::jsonb,$36,$37
  ) ON CONFLICT(canonical_token_id,day,as_of) DO NOTHING RETURNING canonical_token_id`, [
    x.canonicalTokenId,x.day,x.asOf,x.maxInputObservedAt,
    x.tgMentions,x.tgUniqueAuthors,x.tgCopypastaRatio,x.tgSentimentScore,x.tgScamRatio,
    x.xMentions,x.xUniqueAuthors,x.xBotRatio,x.xSentimentScore,
    x.chainTrades,x.chainTransactions,x.chainSwapEvidenceCount,x.chainUniqueWallets,x.chainVolumeUsd,x.chainLiquidityUsd,x.chainSmartMoneyBought,x.chainRugRisk,
    x.tgMentionsZ1h ?? null,x.xMentionsZ1h ?? null,x.chainVolumeZ1h ?? null,
    x.firstMentionTgAt,x.firstMentionXAt,x.firstTradeAt,x.firstSwapEvidenceAt,
    x.attentionScore,x.credibilityScore,x.riskScore,x.momentumScore,x.scoreVersion,
    JSON.stringify(x.scoreReason),JSON.stringify(x.sourceCoverage),x.dataConfidence,x.snapshotSha256,
  ]);
  if (result.rows.length) return x;
  const prior = await tx.query(`SELECT snapshot_sha256 FROM token_daily_cross_platform
    WHERE canonical_token_id=$1 AND day=$2::date AND as_of=$3`, [x.canonicalTokenId,x.day,x.asOf]);
  if (prior.rows.length !== 1 || prior.rows[0]?.snapshot_sha256 !== x.snapshotSha256) {
    throw new Error("Cross-platform snapshot conflict: immutable version differs");
  }
  return x;
}

export async function recordSourceCoverageWindow(
  tx: PgTransaction,
  input: Readonly<{
    sourceSystem: SourceSystem;
    windowStart: Date | string;
    windowEnd: Date | string;
    knownAt: Date | string;
    status: CoverageStatus;
    evidenceCount?: number | null;
    details?: Record<string, unknown>;
  }>,
): Promise<void> {
  if (!["tg", "x", "blockchain"].includes(input.sourceSystem)) throw new TypeError("Invalid source system");
  if (!["complete", "partial", "unknown"].includes(input.status)) throw new TypeError("Invalid coverage status");
  const windowStart = toUtcIso(input.windowStart);
  const windowEnd = toUtcIso(input.windowEnd);
  const knownAt = toUtcIso(input.knownAt);
  if (windowStart >= windowEnd) throw new TypeError("Coverage window must have positive duration");
  if (input.status === "complete" && knownAt < windowEnd) throw new TypeError("Complete coverage cannot be known before window end");
  if (input.evidenceCount !== undefined && input.evidenceCount !== null &&
      (!Number.isSafeInteger(input.evidenceCount) || input.evidenceCount < 0)) {
    throw new TypeError("Invalid evidence count");
  }
  const details = input.details ?? {};
  if (!details || typeof details !== "object" || Array.isArray(details)) throw new TypeError("Coverage details must be an object");
  const rawScope = details.scope ?? "timeline_events";
  if (typeof rawScope !== "string" || !["timeline_events","token_swap_evidence_revisions","settled_trade_tape"].includes(rawScope)) {
    throw new TypeError("Invalid coverage scope");
  }
  const scope = rawScope as CoverageScope;
  const detailsSha256 = sha256(stableJson(details));
  const inserted = await tx.query(`INSERT INTO source_coverage_windows
    (source_system,scope,window_start,window_end,known_at,status,evidence_count,details,details_sha256)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
    ON CONFLICT DO NOTHING RETURNING source_system`, [
    input.sourceSystem,scope,windowStart,windowEnd,knownAt,input.status,input.evidenceCount ?? null,
    JSON.stringify(details),detailsSha256,
  ]);
  if (inserted.rows.length) return;
  const prior = await tx.query(`SELECT status,evidence_count,details_sha256 FROM source_coverage_windows
    WHERE source_system=$1 AND scope=$2 AND window_start=$3 AND window_end=$4 AND known_at=$5`,
  [input.sourceSystem,scope,windowStart,windowEnd,knownAt]);
  if (prior.rows.length !== 1 || prior.rows[0]?.status !== input.status ||
      Number(prior.rows[0]?.evidence_count ?? -1) !== (input.evidenceCount ?? -1) ||
      prior.rows[0]?.details_sha256 !== detailsSha256) {
    throw new Error("Source coverage conflict: immutable window differs");
  }
}

const SAFE_NUMERIC = (field: string) =>
  `CASE WHEN jsonb_typeof(payload->'${field}')='number' AND length(payload->>'${field}') < 64 THEN (payload->>'${field}')::numeric END`;

export async function refreshTokenDailyCrossPlatform(
  tx: PgTransaction, canonicalTokenId: TokenId, day: string, asOf: Date | string,
): Promise<ValidatedCrossPlatformSnapshot> {
  if (parseTokenId(canonicalTokenId)?.id !== canonicalTokenId) throw new TypeError("Noncanonical token ID");
  const normalizedAsOf = toUtcIso(asOf);
  if (normalizedAsOf < day + "T00:00:00.000Z") throw new TypeError("as_of cannot precede the requested UTC day");
  const sentiment = SAFE_NUMERIC("sentiment_score");
  const copypasta = SAFE_NUMERIC("copypasta_ratio");
  const scam = SAFE_NUMERIC("scam_ratio");
  const bot = SAFE_NUMERIC("bot_ratio");
  const rug = SAFE_NUMERIC("rug_risk");
  const volume = SAFE_NUMERIC("volume_usd");
  const sql = `WITH token_events AS (
    SELECT te.source_system,te.source_event_kind,te.event_key,te.timeline_kind,
      te.occurred_at,te.observed_at,inbox.ingested_at,te.payload
    FROM timeline_events te
    JOIN timeline_event_entities token_entity
      ON token_entity.source_system=te.source_system
      AND token_entity.source_event_kind=te.source_event_kind
      AND token_entity.event_key=te.event_key
      AND token_entity.kind='token' AND token_entity.canonical_id=$1
    JOIN intelligence_inbox inbox
      ON inbox.source_system=te.source_system
      AND inbox.event_kind=te.source_event_kind AND inbox.event_key=te.event_key
      AND inbox.ingested_at <= $3::timestamptz
    WHERE te.source_system IN ('tg','x','blockchain')
      AND te.observed_at <= $3::timestamptz
      AND te.occurred_at <= $3::timestamptz
      AND te.occurred_at >= (($2::date - INTERVAL '7 days') AT TIME ZONE 'UTC')
      AND te.occurred_at < (($2::date + INTERVAL '1 day') AT TIME ZONE 'UTC')
  ), day_events AS (
    SELECT * FROM token_events
    WHERE occurred_at >= ($2::date::timestamp AT TIME ZONE 'UTC') AND occurred_at < (($2::date + INTERVAL '1 day') AT TIME ZONE 'UTC')
  ), first_events AS (
    SELECT
      MIN(te.occurred_at) FILTER (WHERE te.source_system='tg' AND te.timeline_kind='tg_message_published') AS first_mention_tg_at,
      MIN(te.occurred_at) FILTER (WHERE te.source_system='x' AND te.timeline_kind='tweet_published') AS first_mention_x_at,
      MIN(te.occurred_at) FILTER (WHERE te.source_system='blockchain' AND te.timeline_kind='trade_executed') AS first_trade_at,
      MAX(GREATEST(te.observed_at,inbox.ingested_at)) AS max_historical_event_observed_at
    FROM timeline_events te
    JOIN timeline_event_entities token_entity
      ON token_entity.source_system=te.source_system
      AND token_entity.source_event_kind=te.source_event_kind
      AND token_entity.event_key=te.event_key
      AND token_entity.kind='token' AND token_entity.canonical_id=$1
    JOIN intelligence_inbox inbox
      ON inbox.source_system=te.source_system
      AND inbox.event_kind=te.source_event_kind AND inbox.event_key=te.event_key
      AND inbox.ingested_at <= $3::timestamptz
    WHERE te.source_system IN ('tg','x','blockchain')
      AND te.observed_at <= $3::timestamptz AND te.occurred_at <= $3::timestamptz
  ), coverage AS (
    SELECT source_system,
      CASE
        WHEN bool_or(status='complete' AND window_start <= ($2::date::timestamp AT TIME ZONE 'UTC')
          AND window_end >= (($2::date + INTERVAL '1 day') AT TIME ZONE 'UTC')) THEN 'complete'
        WHEN bool_or(status='partial') THEN 'partial'
        ELSE 'unknown'
      END AS coverage_status,
      MAX(GREATEST(known_at,created_at)) AS known_at
    FROM source_coverage_windows
    WHERE source_system IN ('tg','x','blockchain') AND known_at <= $3::timestamptz AND created_at <= $3::timestamptz
      AND scope='timeline_events'
      AND window_start < (($2::date + INTERVAL '1 day') AT TIME ZONE 'UTC') AND window_end > ($2::date::timestamp AT TIME ZONE 'UTC')
    GROUP BY source_system
  ), coverage_pivot AS (
    SELECT
      COALESCE(MAX(coverage_status) FILTER (WHERE source_system='tg'),'unknown') AS tg_coverage,
      COALESCE(MAX(coverage_status) FILTER (WHERE source_system='x'),'unknown') AS x_coverage,
      COALESCE(MAX(coverage_status) FILTER (WHERE source_system='blockchain'),'unknown') AS blockchain_coverage,
      MAX(known_at) AS max_coverage_known_at
    FROM coverage
  ), trade_coverage AS (
    SELECT
      CASE WHEN bool_or(status='complete' AND window_start <= ($2::date::timestamp AT TIME ZONE 'UTC')
        AND window_end >= (($2::date + INTERVAL '1 day') AT TIME ZONE 'UTC')) THEN 'complete'
        WHEN bool_or(status='partial') THEN 'partial' ELSE 'unknown' END AS coverage_status,
      MAX(GREATEST(known_at,created_at)) AS known_at
    FROM source_coverage_windows
    WHERE source_system='blockchain' AND scope='settled_trade_tape'
      AND known_at <= $3::timestamptz AND created_at <= $3::timestamptz
      AND window_start < (($2::date + INTERVAL '1 day') AT TIME ZONE 'UTC') AND window_end > ($2::date::timestamp AT TIME ZONE 'UTC')
  ), swap_coverage AS (
    SELECT
      CASE WHEN bool_or(status='complete' AND window_start <= ($2::date::timestamp AT TIME ZONE 'UTC')
        AND window_end >= (($2::date + INTERVAL '1 day') AT TIME ZONE 'UTC')) THEN 'complete'
        WHEN bool_or(status='partial') THEN 'partial' ELSE 'unknown' END AS coverage_status,
      MAX(GREATEST(known_at,created_at)) AS known_at
    FROM source_coverage_windows
    WHERE source_system='blockchain' AND scope='token_swap_evidence_revisions'
      AND known_at <= $3::timestamptz AND created_at <= $3::timestamptz
      AND window_start < (($2::date + INTERVAL '1 day') AT TIME ZONE 'UTC') AND window_end > ($2::date::timestamp AT TIME ZONE 'UTC')
  ), relevant_swap_signatures AS (
    SELECT DISTINCT signature
    FROM blockchain_swap_evidence_revisions
    WHERE canonical_token_id=$1 AND observed_at <= $3::timestamptz AND inserted_at <= $3::timestamptz
  ), swap_latest AS (
    SELECT DISTINCT ON (revision.wallet_id,revision.signature)
      revision.wallet_id,revision.signature,revision.state,revision.canonical_token_id,
      revision.slot,revision.occurred_at,revision.observed_at,revision.inserted_at,revision.raw_revision
    FROM blockchain_swap_evidence_revisions revision
    WHERE revision.signature IN (SELECT signature FROM relevant_swap_signatures)
      AND revision.observed_at <= $3::timestamptz AND revision.inserted_at <= $3::timestamptz
    ORDER BY revision.wallet_id,revision.signature,revision.raw_revision DESC
  ), swap_state_meta AS (
    SELECT MAX(GREATEST(observed_at,inserted_at)) AS max_swap_state_observed_at FROM swap_latest
  ), swap_consistent AS (
    SELECT signature,MIN(canonical_token_id) AS canonical_token_id,
      MIN(slot) AS slot,MIN(occurred_at) AS occurred_at,MAX(observed_at) AS observed_at
    FROM swap_latest
    GROUP BY signature
    HAVING BOOL_AND(state='supported')
      AND COUNT(DISTINCT canonical_token_id)=1
      AND COUNT(DISTINCT slot)=1
      AND COUNT(DISTINCT occurred_at)=1
  ), active_swaps AS (
    SELECT consistent.signature,consistent.canonical_token_id,consistent.occurred_at,
      consistent.observed_at,latest.wallet_id
    FROM swap_consistent consistent
    JOIN swap_latest latest ON latest.signature=consistent.signature
      AND latest.state='supported' AND latest.canonical_token_id=consistent.canonical_token_id
      AND latest.slot=consistent.slot AND latest.occurred_at=consistent.occurred_at
    WHERE consistent.canonical_token_id=$1 AND consistent.occurred_at <= $3::timestamptz
  ), event_metrics AS (
    SELECT
      CASE WHEN COUNT(*) FILTER (WHERE source_system='tg' AND timeline_kind='tg_message_published') > 0
        THEN COUNT(*) FILTER (WHERE source_system='tg' AND timeline_kind='tg_message_published')
        WHEN (SELECT tg_coverage FROM coverage_pivot)='complete' THEN 0 ELSE NULL END AS tg_mentions,
      CASE WHEN COUNT(*) FILTER (WHERE source_system='x' AND timeline_kind='tweet_published') > 0
        THEN COUNT(*) FILTER (WHERE source_system='x' AND timeline_kind='tweet_published')
        WHEN (SELECT x_coverage FROM coverage_pivot)='complete' THEN 0 ELSE NULL END AS x_mentions,
      CASE WHEN COUNT(*) FILTER (WHERE source_system='blockchain' AND timeline_kind='chain_transaction') > 0
        THEN COUNT(*) FILTER (WHERE source_system='blockchain' AND timeline_kind='chain_transaction')
        WHEN (SELECT blockchain_coverage FROM coverage_pivot)='complete' THEN 0 ELSE NULL END AS chain_transactions,
      CASE WHEN COUNT(*) FILTER (WHERE source_system='blockchain' AND timeline_kind='trade_executed') > 0
        THEN COUNT(*) FILTER (WHERE source_system='blockchain' AND timeline_kind='trade_executed')
        ELSE NULL END AS chain_trades,
      CASE WHEN COUNT(*) FILTER (WHERE source_system='blockchain' AND timeline_kind='trade_executed') > 0
        AND COUNT(${volume}) FILTER (WHERE source_system='blockchain' AND timeline_kind='trade_executed') =
          COUNT(*) FILTER (WHERE source_system='blockchain' AND timeline_kind='trade_executed')
        THEN SUM(${volume}) FILTER (WHERE source_system='blockchain' AND timeline_kind='trade_executed')
        ELSE NULL END AS chain_volume_usd,
      AVG(${copypasta}) FILTER (WHERE source_system='tg') AS tg_copypasta_ratio,
      AVG(${sentiment}) FILTER (WHERE source_system='tg') AS tg_sentiment_score,
      AVG(${scam}) FILTER (WHERE source_system='tg') AS tg_scam_ratio,
      AVG(${bot}) FILTER (WHERE source_system='x') AS x_bot_ratio,
      AVG(${sentiment}) FILTER (WHERE source_system='x') AS x_sentiment_score,
      AVG(${rug}) FILTER (WHERE source_system='blockchain') AS chain_rug_risk,
      CASE WHEN COUNT(*) FILTER (WHERE source_system='blockchain' AND timeline_kind='trade_executed') > 0
        AND COUNT(*) FILTER (WHERE source_system='blockchain' AND timeline_kind='trade_executed'
          AND jsonb_typeof(payload->'smart_money_bought')='boolean') =
          COUNT(*) FILTER (WHERE source_system='blockchain' AND timeline_kind='trade_executed')
        THEN COUNT(*) FILTER (WHERE source_system='blockchain' AND timeline_kind='trade_executed'
          AND payload->>'smart_money_bought'='true')
        ELSE NULL END AS chain_smart_money_bought,
      MAX(GREATEST(observed_at,ingested_at)) AS max_event_observed_at
    FROM day_events
  ), author_metrics AS (
    SELECT
      CASE WHEN COUNT(DISTINCT author.canonical_id) FILTER (WHERE e.source_system='tg') > 0
        THEN COUNT(DISTINCT author.canonical_id) FILTER (WHERE e.source_system='tg')
        WHEN (SELECT tg_coverage FROM coverage_pivot)='complete'
          AND (SELECT tg_mentions FROM event_metrics)=0 THEN 0 ELSE NULL END AS tg_unique_authors,
      CASE WHEN COUNT(DISTINCT author.canonical_id) FILTER (WHERE e.source_system='x') > 0
        THEN COUNT(DISTINCT author.canonical_id) FILTER (WHERE e.source_system='x')
        WHEN (SELECT x_coverage FROM coverage_pivot)='complete'
          AND (SELECT x_mentions FROM event_metrics)=0 THEN 0 ELSE NULL END AS x_unique_authors
    FROM day_events e
    JOIN timeline_event_entities author
      ON author.source_system=e.source_system AND author.source_event_kind=e.source_event_kind
      AND author.event_key=e.event_key AND author.kind='author'
  ), wallet_metrics AS (
    SELECT
      CASE WHEN COUNT(DISTINCT wallet.canonical_id) > 0 THEN COUNT(DISTINCT wallet.canonical_id)
        WHEN (SELECT blockchain_coverage FROM coverage_pivot)='complete'
          AND (SELECT chain_transactions FROM event_metrics)=0 THEN 0 ELSE NULL END AS chain_unique_wallets
    FROM day_events e
    JOIN timeline_event_entities wallet
      ON wallet.source_system=e.source_system AND wallet.source_event_kind=e.source_event_kind
      AND wallet.event_key=e.event_key AND wallet.kind='wallet'
    WHERE e.source_system='blockchain'
  ), swap_metrics AS (
    SELECT
      CASE WHEN COUNT(DISTINCT signature) FILTER (WHERE occurred_at >= ($2::date::timestamp AT TIME ZONE 'UTC') AND occurred_at < (($2::date + INTERVAL '1 day') AT TIME ZONE 'UTC')) > 0
        THEN COUNT(DISTINCT signature) FILTER (WHERE occurred_at >= ($2::date::timestamp AT TIME ZONE 'UTC') AND occurred_at < (($2::date + INTERVAL '1 day') AT TIME ZONE 'UTC'))
        WHEN (SELECT coverage_status FROM swap_coverage)='complete' THEN 0 ELSE NULL END AS chain_swap_evidence_count,
      MIN(occurred_at) AS first_swap_evidence_at
    FROM active_swaps
  ), liquidity AS (
    SELECT ${SAFE_NUMERIC("liquidity_usd")} AS value
    FROM day_events
    WHERE source_system='blockchain' AND jsonb_typeof(payload->'liquidity_usd')='number'
    ORDER BY occurred_at DESC LIMIT 1
  )
  SELECT em.*,am.tg_unique_authors,am.x_unique_authors,wm.chain_unique_wallets,
    sm.chain_swap_evidence_count,sm.first_swap_evidence_at,
    (SELECT value FROM liquidity) AS chain_liquidity_usd,
    cp.tg_coverage,cp.x_coverage,cp.blockchain_coverage,
    fe.first_mention_tg_at,fe.first_mention_x_at,fe.first_trade_at,
    GREATEST(em.max_event_observed_at,cp.max_coverage_known_at,fe.max_historical_event_observed_at,
      swap_meta.max_swap_state_observed_at,tc.known_at,sc.known_at) AS max_input_observed_at
  FROM event_metrics em CROSS JOIN author_metrics am CROSS JOIN wallet_metrics wm
  CROSS JOIN swap_metrics sm CROSS JOIN coverage_pivot cp CROSS JOIN first_events fe
  CROSS JOIN swap_state_meta swap_meta CROSS JOIN trade_coverage tc CROSS JOIN swap_coverage sc`;
  const result = await tx.query(sql, [canonicalTokenId,day,normalizedAsOf]);
  const row = result.rows[0];
  if (!row || !row.max_input_observed_at) throw new Error("No observed events or explicit coverage available for this token/day");
  const n = (value: unknown): number | null => {
    if (value === null || value === undefined) return null;
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) throw new Error("Invalid numeric source aggregate");
    return parsed;
  };
  const snapshot: CrossPlatformSnapshotInput = {
    canonicalTokenId, day, asOf: normalizedAsOf, maxInputObservedAt: timestamp(row.max_input_observed_at),
    tgMentions: n(row.tg_mentions), tgUniqueAuthors: n(row.tg_unique_authors),
    tgCopypastaRatio: n(row.tg_copypasta_ratio), tgSentimentScore: n(row.tg_sentiment_score),
    tgScamRatio: n(row.tg_scam_ratio), xMentions: n(row.x_mentions), xUniqueAuthors: n(row.x_unique_authors),
    xBotRatio: n(row.x_bot_ratio), xSentimentScore: n(row.x_sentiment_score),
    chainTrades: n(row.chain_trades), chainTransactions: n(row.chain_transactions),
    chainSwapEvidenceCount: n(row.chain_swap_evidence_count), chainUniqueWallets: n(row.chain_unique_wallets),
    chainVolumeUsd: n(row.chain_volume_usd), chainLiquidityUsd: n(row.chain_liquidity_usd),
    chainSmartMoneyBought: n(row.chain_smart_money_bought), chainRugRisk: n(row.chain_rug_risk),
    tgMentionsZ1h: null, xMentionsZ1h: null, chainVolumeZ1h: null,
    sourceCoverage: {
      tg: row.tg_coverage === "complete" ? "complete" : row.tg_coverage === "partial" ? "partial" : "unknown",
      x: row.x_coverage === "complete" ? "complete" : row.x_coverage === "partial" ? "partial" : "unknown",
      blockchain: row.blockchain_coverage === "complete" ? "complete" : row.blockchain_coverage === "partial" ? "partial" : "unknown",
    },
    firstMentionTgAt: timestampOrNull(row.first_mention_tg_at),
    firstMentionXAt: timestampOrNull(row.first_mention_x_at),
    firstTradeAt: timestampOrNull(row.first_trade_at),
    firstSwapEvidenceAt: timestampOrNull(row.first_swap_evidence_at),
  };
  return putCrossPlatformSnapshot(tx, snapshot);
}

export async function registerModel(
  tx: PgTransaction,
  input: Readonly<{
    modelId: string; provider: string; name: string; version: string;
    task: "sentiment" | "bot_score" | "token_score" | "narrative" | "embedding" | "explanation";
    trainedAt?: Date | string | null;
    metrics?: Record<string, unknown> | null;
    artifactPath?: string | null;
    status?: "shadow" | "active" | "deprecated";
  }>,
): Promise<void> {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(input.modelId)) throw new TypeError("Invalid model ID");
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(input.provider)) throw new TypeError("Invalid provider ID");
  if (!input.name.trim() || input.name.length > 128 || !input.version.trim() || input.version.length > 64) {
    throw new TypeError("Invalid model identity");
  }
  if (!["sentiment","bot_score","token_score","narrative","embedding","explanation"].includes(input.task)) {
    throw new TypeError("Invalid model task");
  }
  const status = input.status ?? "shadow";
  if (!["shadow","active","deprecated"].includes(status)) throw new TypeError("Invalid model status");
  const metrics = input.metrics ?? null;
  if (metrics !== null && (!metrics || typeof metrics !== "object" || Array.isArray(metrics))) {
    throw new TypeError("Model metrics must be an object");
  }
  const trainedAt = input.trainedAt == null ? null : toUtcIso(input.trainedAt);
  const inserted = await tx.query(`INSERT INTO model_registry
    (model_id,provider,name,version,task,trained_at,metrics,artifact_path,status)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
    ON CONFLICT(model_id) DO NOTHING RETURNING model_id`, [
    input.modelId,input.provider,input.name,input.version,input.task,trainedAt,
    metrics === null ? null : JSON.stringify(metrics),input.artifactPath ?? null,status,
  ]);
  if (inserted.rows.length) return;
  const prior = await tx.query("SELECT provider,name,version,task FROM model_registry WHERE model_id=$1", [input.modelId]);
  if (prior.rows.length !== 1 || prior.rows[0]?.provider !== input.provider ||
      prior.rows[0]?.name !== input.name || prior.rows[0]?.version !== input.version ||
      prior.rows[0]?.task !== input.task) {
    throw new Error("Model registry identity conflict");
  }
}

export async function setModelStatus(
  tx: PgTransaction, modelId: string, status: "shadow" | "active" | "deprecated",
): Promise<void> {
  if (!["shadow","active","deprecated"].includes(status)) throw new TypeError("Invalid model status");
  const result = await tx.query("UPDATE model_registry SET status=$2,updated_at=NOW() WHERE model_id=$1 RETURNING model_id", [modelId,status]);
  if (result.rows.length !== 1) throw new Error("Model is not registered");
}

export async function putFeatureEmbedding(
  tx: PgTransaction,
  input: Readonly<{
    entityId: string; featureVersion: string; asOf: Date | string;
    maxInputObservedAt: Date | string; modelId: string; embedding: readonly number[];
  }>,
): Promise<void> {
  if (parseTokenId(input.entityId)?.id !== input.entityId) throw new TypeError("Embedding entity must be a canonical token ID");
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(input.featureVersion)) throw new TypeError("Invalid feature version");
  if (input.embedding.length !== 1024 || input.embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    throw new TypeError("Embedding must contain exactly 1024 finite numbers");
  }
  const asOf = toUtcIso(input.asOf);
  const maxInputObservedAt = toUtcIso(input.maxInputObservedAt);
  if (maxInputObservedAt > asOf) throw new TypeError("Future-observed embeddings are not allowed");
  const model = await tx.query("SELECT task,status FROM model_registry WHERE model_id=$1", [input.modelId]);
  if (model.rows.length !== 1 || model.rows[0]?.task !== "embedding" || model.rows[0]?.status !== "active") {
    throw new Error("An active registered embedding model is required");
  }
  const vector = "[" + input.embedding.map((value) => Number(value.toFixed(7))).join(",") + "]";
  const embeddingSha256 = sha256(vector);
  const inserted = await tx.query(`INSERT INTO feature_embeddings
    (entity_id,feature_version,as_of,max_input_observed_at,model_id,embedding,embedding_sha256)
    VALUES ($1,$2,$3,$4,$5,$6::vector,$7)
    ON CONFLICT(entity_id,feature_version,as_of) DO NOTHING RETURNING entity_id`, [
    input.entityId,input.featureVersion,asOf,maxInputObservedAt,input.modelId,vector,embeddingSha256,
  ]);
  if (inserted.rows.length) return;
  const prior = await tx.query(`SELECT embedding_sha256,max_input_observed_at,model_id
    FROM feature_embeddings WHERE entity_id=$1 AND feature_version=$2 AND as_of=$3`,
  [input.entityId,input.featureVersion,asOf]);
  if (prior.rows.length !== 1 || prior.rows[0]?.embedding_sha256 !== embeddingSha256 ||
      toUtcIso(timestamp(prior.rows[0]?.max_input_observed_at)) !== maxInputObservedAt ||
      prior.rows[0]?.model_id !== input.modelId) {
    throw new Error("Embedding snapshot conflict: immutable version differs");
  }
}
