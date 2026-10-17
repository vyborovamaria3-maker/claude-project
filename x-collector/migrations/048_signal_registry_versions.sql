-- Version signal definitions, thresholds and evaluation windows.
-- Outcomes remain descriptive measures of observed social attention, not price/PnL.

CREATE TABLE IF NOT EXISTS signal_registry (
  signal_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  display_name TEXT NOT NULL,
  definition JSONB NOT NULL DEFAULT '{}'::JSONB,
  baseline_window_ms BIGINT NOT NULL DEFAULT 3600000 CHECK (baseline_window_ms > 0),
  outcome_window_ms BIGINT NOT NULL DEFAULT 3600000 CHECK (outcome_window_ms > 0),
  minimum_entry_views BIGINT NOT NULL DEFAULT 100 CHECK (minimum_entry_views >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (signal_key, version)
);

INSERT INTO signal_registry
  (signal_key, version, display_name, definition, baseline_window_ms, outcome_window_ms, minimum_entry_views)
VALUES
  ('hype', 1, 'Hype score', '{"origin":"legacy signal_history source","metric_basis":"observed_dataset_views_change_pct"}'::JSONB, 3600000, 3600000, 100),
  ('ultra', 1, 'Ultra signal', '{"origin":"legacy signal_history source","metric_basis":"observed_dataset_views_change_pct"}'::JSONB, 3600000, 3600000, 100),
  ('early_signal', 1, 'Early signal', '{"origin":"legacy signal_history source","metric_basis":"observed_dataset_views_change_pct"}'::JSONB, 3600000, 3600000, 100),
  ('entity', 1, 'Entity signal', '{"origin":"legacy signal_history source","metric_basis":"observed_dataset_views_change_pct"}'::JSONB, 3600000, 3600000, 100)
ON CONFLICT (signal_key, version) DO NOTHING;

CREATE TABLE IF NOT EXISTS signal_thresholds (
  signal_key TEXT NOT NULL,
  signal_version INTEGER NOT NULL CHECK (signal_version > 0),
  threshold_version INTEGER NOT NULL CHECK (threshold_version > 0),
  threshold NUMERIC(5,2) NOT NULL CHECK (threshold BETWEEN 0 AND 100),
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  effective_from BIGINT NOT NULL DEFAULT 0,
  effective_to BIGINT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (signal_key, signal_version, threshold_version),
  FOREIGN KEY (signal_key, signal_version)
    REFERENCES signal_registry(signal_key, version) ON DELETE RESTRICT,
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_thresholds_one_default
  ON signal_thresholds(signal_key, signal_version) WHERE is_default;

INSERT INTO signal_thresholds
  (signal_key, signal_version, threshold_version, threshold, is_default, effective_from, notes)
VALUES
  ('hype', 1, 1, 60, TRUE, 0, 'Migrated from legacy strategy threshold'),
  ('ultra', 1, 1, 70, TRUE, 0, 'Migrated from legacy strategy threshold'),
  ('early_signal', 1, 1, 60, TRUE, 0, 'Migrated from legacy strategy threshold'),
  ('entity', 1, 1, 60, TRUE, 0, 'Initial evaluation threshold')
ON CONFLICT (signal_key, signal_version, threshold_version) DO NOTHING;

ALTER TABLE signal_history
  ADD COLUMN IF NOT EXISTS signal_version INTEGER NOT NULL DEFAULT 1 CHECK (signal_version > 0);

-- The version is part of signal identity; otherwise v1 and v2 could collide
-- when a mint emits the same source at the same millisecond.
ALTER TABLE signal_history DROP CONSTRAINT IF EXISTS signal_history_pkey;
ALTER TABLE signal_history
  ADD CONSTRAINT signal_history_pkey PRIMARY KEY (source, signal_version, mint, signal_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'signal_history_registry_fk'
      AND conrelid = 'signal_history'::regclass
  ) THEN
    ALTER TABLE signal_history
      ADD CONSTRAINT signal_history_registry_fk
      FOREIGN KEY (source, signal_version)
      REFERENCES signal_registry(signal_key, version) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_signal_history_version_time
  ON signal_history(source, signal_version, signal_at DESC, mint);

ALTER TABLE signal_quality_outcomes
  ADD COLUMN IF NOT EXISTS signal_version INTEGER NOT NULL DEFAULT 1 CHECK (signal_version > 0),
  ADD COLUMN IF NOT EXISTS baseline_window_start BIGINT,
  ADD COLUMN IF NOT EXISTS baseline_window_end BIGINT,
  ADD COLUMN IF NOT EXISTS outcome_window_start BIGINT,
  ADD COLUMN IF NOT EXISTS outcome_window_end BIGINT;

UPDATE signal_quality_outcomes o
SET baseline_window_start = o.signal_at - r.baseline_window_ms,
    baseline_window_end = o.signal_at,
    outcome_window_start = o.signal_at + (o.horizon_hours * 3600000)::BIGINT,
    outcome_window_end = o.signal_at + (o.horizon_hours * 3600000)::BIGINT + r.outcome_window_ms
FROM signal_registry r
WHERE r.signal_key = o.source
  AND r.version = o.signal_version
  AND (o.baseline_window_start IS NULL OR o.baseline_window_end IS NULL
    OR o.outcome_window_start IS NULL OR o.outcome_window_end IS NULL);

ALTER TABLE signal_quality_outcomes
  ALTER COLUMN baseline_window_start SET NOT NULL,
  ALTER COLUMN baseline_window_end SET NOT NULL,
  ALTER COLUMN outcome_window_start SET NOT NULL,
  ALTER COLUMN outcome_window_end SET NOT NULL;

ALTER TABLE signal_quality_outcomes DROP CONSTRAINT IF EXISTS signal_quality_outcomes_pkey;
ALTER TABLE signal_quality_outcomes
  ADD CONSTRAINT signal_quality_outcomes_pkey
  PRIMARY KEY (source, signal_version, mint, signal_at, horizon_hours);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'signal_quality_outcomes_registry_fk'
      AND conrelid = 'signal_quality_outcomes'::regclass
  ) THEN
    ALTER TABLE signal_quality_outcomes
      ADD CONSTRAINT signal_quality_outcomes_registry_fk
      FOREIGN KEY (source, signal_version)
      REFERENCES signal_registry(signal_key, version) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_signal_quality_version_source_time
  ON signal_quality_outcomes(source, signal_version, horizon_hours, signal_at DESC);

CREATE OR REPLACE FUNCTION refresh_signal_quality_outcomes(
  p_from BIGINT DEFAULT NULL,
  p_to BIGINT DEFAULT NULL,
  p_horizons INTEGER[] DEFAULT ARRAY[6, 24]
) RETURNS INTEGER AS $$
DECLARE
  from_ts BIGINT := COALESCE(p_from, (EXTRACT(EPOCH FROM NOW()) * 1000 - 90 * 86400000::BIGINT)::BIGINT);
  to_ts BIGINT := COALESCE(p_to, (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT);
  now_ms BIGINT := (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT;
  cnt INTEGER;
BEGIN
  IF from_ts >= to_ts THEN
    RAISE EXCEPTION 'p_from must be earlier than p_to';
  END IF;
  IF p_horizons IS NULL OR cardinality(p_horizons) = 0
     OR EXISTS (SELECT 1 FROM unnest(p_horizons) AS h WHERE h IS NULL OR h < 1 OR h > 168) THEN
    RAISE EXCEPTION 'p_horizons must contain hours between 1 and 168';
  END IF;

  WITH horizons AS (
    SELECT DISTINCT unnest(p_horizons)::INTEGER AS horizon_hours
  ),
  candidates AS (
    SELECT s.source, s.signal_version, s.mint, s.signal_at, s.score, s.details,
      h.horizon_hours, r.baseline_window_ms, r.outcome_window_ms, r.minimum_entry_views
    FROM signal_history s
    JOIN signal_registry r
      ON r.signal_key = s.source AND r.version = s.signal_version
    CROSS JOIN horizons h
    WHERE s.signal_at >= from_ts AND s.signal_at < to_ts
  ),
  observations AS (
    SELECT c.*,
      c.signal_at - c.baseline_window_ms AS baseline_window_start,
      c.signal_at AS baseline_window_end,
      c.signal_at + (c.horizon_hours * 3600000)::BIGINT AS outcome_window_start,
      c.signal_at + (c.horizon_hours * 3600000)::BIGINT + c.outcome_window_ms AS outcome_window_end,
      e.observed_at AS entry_observed_at,
      e.views AS entry_views,
      x.observed_at AS exit_observed_at,
      x.views AS exit_views
    FROM candidates c
    LEFT JOIN LATERAL (
      SELECT a.observed_at, a.views
      FROM mint_attention_snapshots a
      WHERE a.mint = c.mint
        AND a.observed_at <= c.signal_at
        AND a.observed_at >= c.signal_at - c.baseline_window_ms
      ORDER BY a.observed_at DESC
      LIMIT 1
    ) e ON TRUE
    LEFT JOIN LATERAL (
      SELECT a.observed_at, a.views
      FROM mint_attention_snapshots a
      WHERE a.mint = c.mint
        AND a.observed_at >= c.signal_at + (c.horizon_hours * 3600000)::BIGINT
        AND a.observed_at < c.signal_at + (c.horizon_hours * 3600000)::BIGINT + c.outcome_window_ms
      ORDER BY a.observed_at ASC
      LIMIT 1
    ) x ON TRUE
  )
  INSERT INTO signal_quality_outcomes (
    source, signal_version, mint, signal_at, horizon_hours, score,
    baseline_window_start, baseline_window_end, outcome_window_start, outcome_window_end,
    entry_observed_at, entry_views, exit_observed_at, exit_views,
    attention_change_pct, outcome_status, details, evaluated_at
  )
  SELECT o.source, o.signal_version, o.mint, o.signal_at, o.horizon_hours, o.score,
    o.baseline_window_start, o.baseline_window_end, o.outcome_window_start, o.outcome_window_end,
    o.entry_observed_at, o.entry_views, o.exit_observed_at, o.exit_views,
    CASE
      WHEN o.entry_views >= o.minimum_entry_views AND o.exit_views IS NOT NULL
      THEN ROUND(((o.exit_views - o.entry_views)::NUMERIC / NULLIF(o.entry_views, 0)) * 100, 4)
      ELSE NULL
    END,
    CASE
      WHEN o.entry_observed_at IS NULL THEN 'missing_entry'
      WHEN o.entry_views IS NULL OR o.entry_views < o.minimum_entry_views THEN 'low_baseline'
      WHEN o.exit_observed_at IS NOT NULL THEN 'ready'
      WHEN now_ms < o.outcome_window_end THEN 'pending'
      ELSE 'missing_exit'
    END,
    jsonb_build_object(
      'metric_basis', 'observed_dataset_views_change_pct',
      'signal_details', COALESCE(o.details, '{}'::JSONB),
      'signal_version', o.signal_version,
      'baseline_window_start', o.baseline_window_start,
      'baseline_window_end_exclusive', o.baseline_window_end,
      'outcome_window_start', o.outcome_window_start,
      'outcome_window_end_exclusive', o.outcome_window_end,
      'minimum_entry_views', o.minimum_entry_views
    ),
    now()
  FROM observations o
  ON CONFLICT (source, signal_version, mint, signal_at, horizon_hours) DO UPDATE SET
    score = EXCLUDED.score,
    baseline_window_start = EXCLUDED.baseline_window_start,
    baseline_window_end = EXCLUDED.baseline_window_end,
    outcome_window_start = EXCLUDED.outcome_window_start,
    outcome_window_end = EXCLUDED.outcome_window_end,
    entry_observed_at = EXCLUDED.entry_observed_at,
    entry_views = EXCLUDED.entry_views,
    exit_observed_at = EXCLUDED.exit_observed_at,
    exit_views = EXCLUDED.exit_views,
    attention_change_pct = EXCLUDED.attention_change_pct,
    outcome_status = EXCLUDED.outcome_status,
    details = EXCLUDED.details,
    evaluated_at = EXCLUDED.evaluated_at
  WHERE (
    signal_quality_outcomes.score,
    signal_quality_outcomes.baseline_window_start,
    signal_quality_outcomes.baseline_window_end,
    signal_quality_outcomes.outcome_window_start,
    signal_quality_outcomes.outcome_window_end,
    signal_quality_outcomes.entry_observed_at,
    signal_quality_outcomes.entry_views,
    signal_quality_outcomes.exit_observed_at,
    signal_quality_outcomes.exit_views,
    signal_quality_outcomes.attention_change_pct,
    signal_quality_outcomes.outcome_status,
    signal_quality_outcomes.details
  ) IS DISTINCT FROM (
    EXCLUDED.score,
    EXCLUDED.baseline_window_start,
    EXCLUDED.baseline_window_end,
    EXCLUDED.outcome_window_start,
    EXCLUDED.outcome_window_end,
    EXCLUDED.entry_observed_at,
    EXCLUDED.entry_views,
    EXCLUDED.exit_observed_at,
    EXCLUDED.exit_views,
    EXCLUDED.attention_change_pct,
    EXCLUDED.outcome_status,
    EXCLUDED.details
  );

  GET DIAGNOSTICS cnt = ROW_COUNT;
  RETURN cnt;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE VIEW v_signal_quality_mart AS
SELECT
  source,
  horizon_hours,
  (signal_at / 86400000) * 86400000 AS day_start_ms,
  CASE
    WHEN score < 25 THEN '00-24'
    WHEN score < 50 THEN '25-49'
    WHEN score < 70 THEN '50-69'
    WHEN score < 85 THEN '70-84'
    ELSE '85+'
  END AS score_band,
  COUNT(*)::BIGINT AS candidate_signals,
  COUNT(*) FILTER (WHERE outcome_status = 'ready')::BIGINT AS ready_outcomes,
  ROUND(100.0 * COUNT(*) FILTER (WHERE outcome_status = 'ready') / NULLIF(COUNT(*), 0), 2) AS coverage_pct,
  COUNT(*) FILTER (WHERE outcome_status = 'pending')::BIGINT AS pending_outcomes,
  COUNT(*) FILTER (WHERE outcome_status = 'missing_entry')::BIGINT AS missing_entry,
  COUNT(*) FILTER (WHERE outcome_status = 'missing_exit')::BIGINT AS missing_exit,
  COUNT(*) FILTER (WHERE outcome_status = 'low_baseline')::BIGINT AS low_baseline,
  ROUND(AVG(attention_change_pct) FILTER (WHERE outcome_status = 'ready'), 4) AS avg_attention_change_pct,
  ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY attention_change_pct)
    FILTER (WHERE outcome_status = 'ready'))::NUMERIC, 4) AS median_attention_change_pct,
  ROUND(100.0 * AVG(CASE WHEN attention_change_pct > 0 THEN 1.0 ELSE 0.0 END)
    FILTER (WHERE outcome_status = 'ready'), 2) AS positive_attention_rate_pct,
  signal_version
FROM signal_quality_outcomes
GROUP BY source, signal_version, horizon_hours, day_start_ms, score_band;

CREATE OR REPLACE VIEW v_signal_quality_summary AS
SELECT
  source,
  horizon_hours,
  CASE
    WHEN score < 25 THEN '00-24'
    WHEN score < 50 THEN '25-49'
    WHEN score < 70 THEN '50-69'
    WHEN score < 85 THEN '70-84'
    ELSE '85+'
  END AS score_band,
  COUNT(*)::BIGINT AS candidate_signals,
  COUNT(*) FILTER (WHERE outcome_status = 'ready')::BIGINT AS ready_outcomes,
  ROUND(100.0 * COUNT(*) FILTER (WHERE outcome_status = 'ready') / NULLIF(COUNT(*), 0), 2) AS coverage_pct,
  ROUND(AVG(attention_change_pct) FILTER (WHERE outcome_status = 'ready'), 4) AS avg_attention_change_pct,
  ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY attention_change_pct)
    FILTER (WHERE outcome_status = 'ready'))::NUMERIC, 4) AS median_attention_change_pct,
  ROUND(100.0 * AVG(CASE WHEN attention_change_pct > 0 THEN 1.0 ELSE 0.0 END)
    FILTER (WHERE outcome_status = 'ready'), 2) AS positive_attention_rate_pct,
  signal_version
FROM signal_quality_outcomes
GROUP BY source, signal_version, horizon_hours, score_band;

CREATE OR REPLACE VIEW v_signal_quality_by_mint AS
SELECT
  source,
  mint,
  horizon_hours,
  COUNT(*)::BIGINT AS candidate_signals,
  COUNT(*) FILTER (WHERE outcome_status = 'ready')::BIGINT AS ready_outcomes,
  ROUND(100.0 * COUNT(*) FILTER (WHERE outcome_status = 'ready') / NULLIF(COUNT(*), 0), 2) AS coverage_pct,
  MIN(signal_at) AS first_signal_at,
  MAX(signal_at) AS last_signal_at,
  ROUND(AVG(score), 4) AS avg_signal_score,
  ROUND(AVG(attention_change_pct) FILTER (WHERE outcome_status = 'ready'), 4) AS avg_attention_change_pct,
  ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY attention_change_pct)
    FILTER (WHERE outcome_status = 'ready'))::NUMERIC, 4) AS median_attention_change_pct,
  ROUND(100.0 * AVG(CASE WHEN attention_change_pct > 0 THEN 1.0 ELSE 0.0 END)
    FILTER (WHERE outcome_status = 'ready'), 2) AS positive_attention_rate_pct,
  signal_version
FROM signal_quality_outcomes
GROUP BY source, signal_version, mint, horizon_hours;

-- Descriptive attribution only: one outcome can be attributed to multiple authors,
-- so rows in this view are not independent observations for causal inference.
CREATE OR REPLACE VIEW v_signal_quality_by_author AS
WITH attributed AS (
  SELECT DISTINCT
    o.source, o.signal_version, o.horizon_hours, o.mint, o.signal_at,
    o.outcome_status, o.attention_change_pct, t.handle
  FROM signal_quality_outcomes o
  JOIN tweet_token_links l
    ON l.mint = o.mint AND l.match_level IN ('exact','confirmed')
  JOIN twitter_tweets t ON t.tweet_id = l.tweet_id
  WHERE t.posted_at IS NOT NULL
    AND t.posted_at >= o.baseline_window_start
    AND t.posted_at < o.baseline_window_end
)
SELECT
  source,
  handle,
  horizon_hours,
  COUNT(*)::BIGINT AS attributed_signals,
  COUNT(*) FILTER (WHERE outcome_status = 'ready')::BIGINT AS ready_outcomes,
  ROUND(100.0 * COUNT(*) FILTER (WHERE outcome_status = 'ready') / NULLIF(COUNT(*), 0), 2) AS coverage_pct,
  ROUND(AVG(attention_change_pct) FILTER (WHERE outcome_status = 'ready'), 4) AS avg_attention_change_pct,
  ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY attention_change_pct)
    FILTER (WHERE outcome_status = 'ready'))::NUMERIC, 4) AS median_attention_change_pct,
  ROUND(100.0 * AVG(CASE WHEN attention_change_pct > 0 THEN 1.0 ELSE 0.0 END)
    FILTER (WHERE outcome_status = 'ready'), 2) AS positive_attention_rate_pct,
  signal_version
FROM attributed
GROUP BY source, signal_version, handle, horizon_hours;
