import { exec, q } from "../../../lib/trade/pg";
import { log } from "../../../lib/trade/logger";
import { metrics } from "../../core/metrics";
import { getTopEntities } from "../analytics/entity-stats";
import { computeTrend } from "../analytics/trends";
import { detectKOLs, type DetectedKOL } from "../authors/detector";
import type { EntityType } from "../entities/extractor";
import { SIGNAL_CONFIG, SIGNAL_SOURCE, type SignalScoringConfig } from "./config";
import { calculatePriority, type Priority } from "./priority";
import { calculateSignalScore, type SignalFactors, type SignalLevel } from "./scorer";
import { calculateWeightedSignal } from "./weighted-scorer";

export interface SignalMetadata {
  entity_type: EntityType;
  current_mentions: number;
  previous_mentions: number;
  unique_authors: number;
  velocity: number;
  age_hours: number;
  window_hours: number;
  /** Авторы текущего окна, которые прошли порог KOL (score >= 60). */
  kolDetected: boolean;
  authors: string[];
  /** Максимальный Influence Score среди kolDetected авторов. Не влияет на score v1. */
  authorInfluence?: number;
  /** Weighted layer v2: score v1 до взвешивания (== DetectedSignal.score). */
  baseScore?: number;
  /** Weighted layer v2: base * 0.6 + influence * 0.25 + trend * 0.15, ∈ [0, 100]. */
  weightedScore?: number;
  /** Weighted layer v2: Influence Score автора для формулы (0 — KOL нет). */
  kolInfluence?: number;
  /** Priority layer v2: LOW | NORMAL | IMPORTANT | URGENT. */
  priority?: Priority;
}

export interface DetectedSignal {
  entity: string;
  score: number;
  level: SignalLevel;
  factors: SignalFactors;
  /** Influence Score KOL-автора сущности (optional factor; score не меняет). */
  authorInfluence?: number;
  /** JSON, который уходит в signal_history.details. */
  metadata: SignalMetadata;
}

/** Сырые метрики одной сущности: текущее/предыдущее окно + авторы + первое упоминание. */
export interface EntitySignalMetrics {
  entityType: EntityType;
  value: string;
  currentMentions: number;
  previousMentions: number;
  uniqueAuthors: number;
  /** epoch ms первого упоминания; null — неизвестно. */
  firstSeen: number | null;
  /** Авторы, упоминавшие сущность в текущем окне. */
  authors?: string[];
}

export interface DetectOptions {
  /** Окно наблюдения в часах. default 24 */
  hours?: number;
  /** Сколько топ-сущностей рассматривать. default 20 */
  limit?: number;
  /** Какие сущности сигналить. default "TOKEN" */
  type?: EntityType | "ALL";
  /** Порог отсечки score. default SIGNAL_CONFIG.minScore (50) */
  minScore?: number;
  config?: SignalScoringConfig;
}

export interface ScoreOptions {
  hours: number;
  now: number;
  minScore: number;
  config: SignalScoringConfig;
}

/** Чистая часть: одна сущность → сигнал. */
export function buildSignal(row: EntitySignalMetrics, options: ScoreOptions): DetectedSignal {
  const { hours, now, config } = options;
  const velocity = hours > 0 ? row.currentMentions / hours : 0;
  const ageHours = row.firstSeen == null ? 0 : Math.max((now - row.firstSeen) / 3_600_000, 0);
  const scored = calculateSignalScore(
    {
      entity: row.value,
      currentMentions: row.currentMentions,
      previousMentions: row.previousMentions,
      uniqueAuthors: row.uniqueAuthors,
      velocity,
      age: ageHours,
    },
    config,
  );
  return {
    entity: row.value,
    score: scored.score,
    level: scored.level,
    factors: scored.factors,
    metadata: {
      entity_type: row.entityType,
      current_mentions: row.currentMentions,
      previous_mentions: row.previousMentions,
      unique_authors: row.uniqueAuthors,
      velocity: Math.round(velocity * 1_000) / 1_000,
      age_hours: Math.round(ageHours * 100) / 100,
      window_hours: hours,
      kolDetected: false,
      authors: [],
    },
  };
}

/** Чистая часть: скоринг всех метрик + фильтр по порогу, сортировка по score DESC. */
export function scoreEntities(rows: EntitySignalMetrics[], options: ScoreOptions): DetectedSignal[] {
  return rows
    .map((row) => buildSignal(row, options))
    .filter((signal) => signal.score >= options.minScore)
    .sort((a, b) => b.score - a.score || a.entity.localeCompare(b.entity));
}

interface RawMetricsRow {
  entity_type: string;
  value: string;
  current_mentions: number | string;
  previous_mentions: number | string;
  unique_authors: number | string;
  first_seen: number | string | null;
  authors: string[] | null;
}

async function fetchEntityMetrics(
  candidates: Array<{ entity_type: string; value: string }>,
  currentStart: number,
  previousStart: number,
): Promise<EntitySignalMetrics[]> {
  const rows = await q<RawMetricsRow>(
    `WITH c(value, entity_type) AS (
       SELECT * FROM unnest($1::text[], $2::text[])
     )
     SELECT c.entity_type,
            c.value,
            COUNT(e.id) FILTER (WHERE COALESCE(t.posted_at, t.first_seen_at) >= $3)::int AS current_mentions,
            COUNT(e.id) FILTER (WHERE COALESCE(t.posted_at, t.first_seen_at) >= $4
                                  AND COALESCE(t.posted_at, t.first_seen_at) < $3)::int AS previous_mentions,
            COUNT(DISTINCT t.handle) FILTER (WHERE COALESCE(t.posted_at, t.first_seen_at) >= $3)::int AS unique_authors,
            ARRAY_AGG(DISTINCT t.handle) FILTER (WHERE COALESCE(t.posted_at, t.first_seen_at) >= $3)::text[] AS authors,
            MIN(COALESCE(t.posted_at, t.first_seen_at))::bigint AS first_seen
       FROM c
       LEFT JOIN tweet_entities e ON e.entity_type = c.entity_type AND e.value = c.value
       LEFT JOIN twitter_tweets t ON t.tweet_id = e.tweet_id
      GROUP BY c.entity_type, c.value`,
    [
      candidates.map((c) => c.value),
      candidates.map((c) => c.entity_type),
      currentStart,
      previousStart,
    ]
  );
  return rows.map((r) => ({
    entityType: r.entity_type as EntityType,
    value: r.value,
    currentMentions: Number(r.current_mentions),
    previousMentions: Number(r.previous_mentions),
    uniqueAuthors: Number(r.unique_authors),
    firstSeen: r.first_seen == null ? null : Number(r.first_seen),
    authors: r.authors ?? [],
  }));
}

/**
 * Чистая часть KOL-интеграции: раскладывает influence-скоры авторов по сигналам.
 * Добавляет metadata.kolDetected / metadata.authors / authorInfluence.
 * Сcore и factors сигналов НЕ меняются.
 */
export function applyAuthorInfluence(
  signals: DetectedSignal[],
  rows: EntitySignalMetrics[],
  influenceByHandle: Map<string, number>,
): void {
  if (signals.length === 0 || influenceByHandle.size === 0) return;

  const authorsByKey = new Map(rows.map((r) => [`${r.entityType} ${r.value}`, r.authors ?? []]));

  for (const signal of signals) {
    const key = `${signal.metadata.entity_type} ${signal.entity}`;
    const kolAuthors = (authorsByKey.get(key) ?? [])
      .filter((handle) => influenceByHandle.has(handle.toLowerCase()))
      .sort();
    if (kolAuthors.length === 0) continue;

    let influence = 0;
    for (const handle of kolAuthors) {
      influence = Math.max(influence, influenceByHandle.get(handle.toLowerCase()) ?? 0);
    }
    signal.authorInfluence = influence;
    signal.metadata.kolDetected = true;
    signal.metadata.authors = kolAuthors;
    signal.metadata.authorInfluence = influence;
  }
}

/**
 * Optional factor: authorInfluence. Если среди авторов сущности есть KOL
 * (Influence Score >= порога детектора), в metadata добавляются
 * kolDetected / authors / authorInfluence. Сcore сигнала НЕ меняется.
 * Ошибка KOL-запроса не валит детектор — аннотация просто пропускается.
 */
async function enrichWithAuthorInfluence(
  signals: DetectedSignal[],
  rows: EntitySignalMetrics[],
  hours: number,
): Promise<void> {
  if (signals.length === 0) return;

  let kols: DetectedKOL[];
  try {
    kols = await detectKOLs({ hours });
  } catch (e) {
    log.warn("kol annotation skipped", { error: String(e instanceof Error ? e.message : e) });
    return;
  }
  if (kols.length === 0) return;

  applyAuthorInfluence(
    signals,
    rows,
    new Map(kols.map((kol) => [kol.handle.toLowerCase(), kol.score])),
  );
}

/**
 * Weighted layer v2: считает weightedScore и priority поверх готового
 * v1-сигнала и дополняет metadata (baseScore / weightedScore / kolInfluence / priority).
 * score и factors v1 не меняются — слой только читает их.
 * Тренд берётся из текущего и предыдущего окон (computeTrend — чистый расчёт, без БД).
 */
export function applyWeightedScoring(signals: DetectedSignal[]): void {
  for (const signal of signals) {
    const meta = signal.metadata;
    const trend = computeTrend({
      value: signal.entity,
      current: meta.current_mentions,
      previous: meta.previous_mentions,
    });
    const kolInfluence = signal.authorInfluence ?? 0;
    const weighted = calculateWeightedSignal(
      { entity: signal.entity, score: signal.score, level: signal.level },
      {
        influenceScore: kolInfluence,
        uniqueAuthors: meta.unique_authors,
        trend: trend.growthPercent,
        velocity: meta.velocity,
      },
    );
    const priority = calculatePriority({
      level: weighted.level,
      kolInfluence,
      trend: trend.trend,
    });

    meta.baseScore = weighted.baseScore;
    meta.weightedScore = weighted.weightedScore;
    meta.kolInfluence = kolInfluence;
    meta.priority = priority.priority;
  }
}

/**
 * Детектор сигналов: топ сущностей за окно (analytics) → метрики текущего и
 * предыдущего окон → calculateSignalScore → отсечка score >= minScore
 * → опциональная KOL-аннотация (score v1 не меняется)
 * → weighted layer v2 (baseScore/weightedScore/priority в metadata, score v1 не меняется).
 * Ничего не пишет в БД: сохранение — отдельный вызов saveSignals().
 */
export async function detectSignals(options: DetectOptions = {}): Promise<DetectedSignal[]> {
  const config = options.config ?? SIGNAL_CONFIG;
  const hours = options.hours ?? config.windowHours;
  const limit = options.limit ?? 20;
  const minScore = options.minScore ?? config.minScore;
  const type = options.type ?? "TOKEN";

  try {
    const candidates = await getTopEntities({
      type: type === "ALL" ? undefined : type,
      hours,
      limit,
    });
    if (candidates.length === 0) return [];

    const now = Date.now();
    const rows = await fetchEntityMetrics(
      candidates.map((c) => ({ entity_type: c.entity_type, value: c.value })),
      now - hours * 3_600_000,
      now - hours * 2 * 3_600_000,
    );
    const signals = scoreEntities(rows, { hours, now, minScore, config });
    await enrichWithAuthorInfluence(signals, rows, hours);
    applyWeightedScoring(signals);
    return signals;
  } catch (e) {
    metrics.signalsErrors += 1;
    throw e;
  }
}

export interface SaveSignalsOptions {
  source?: string;
  signalAt?: number;
}

/**
 * Пишет сигналы в существующую таблицу signal_history (011/014):
 * entity → mint, created_at → signal_at, metadata → details, level → колонка level.
 * Идемпотентно: повтор той же секунды обновляет строку (PK source+mint+signal_at).
 */
export async function saveSignals(
  signals: DetectedSignal[],
  options: SaveSignalsOptions = {},
): Promise<number> {
  if (signals.length === 0) return 0;
  const source = options.source ?? SIGNAL_SOURCE;
  const signalAt = options.signalAt ?? Date.now();

  const values: unknown[] = [];
  const placeholders = signals.map((s, i) => {
    const off = i * 6;
    values.push(source, s.entity, signalAt, s.score, s.level, JSON.stringify(s.metadata));
    return `($${off + 1},$${off + 2},$${off + 3},$${off + 4},$${off + 5},$${off + 6}::jsonb)`;
  }).join(",");

  try {
    const saved = await exec(
      `INSERT INTO signal_history (source, mint, signal_at, score, level, details)
       VALUES ${placeholders}
       ON CONFLICT (source, mint, signal_at)
       DO UPDATE SET score = EXCLUDED.score,
                     level = EXCLUDED.level,
                     details = EXCLUDED.details`,
      values,
    );
    metrics.signalsCreated += saved;
    return saved;
  } catch (e) {
    metrics.signalsErrors += 1;
    throw e;
  }
}
