-- Signal-quality evaluation over observed social attention, not token prices or trading returns.
-- Outcomes are only eligible when the entry snapshot is close to the signal and the
-- forward snapshot lands inside the fixed horizon window. Missing coverage stays explicit.

CREATE TABLE IF NOT EXISTS signal_quality_outcomes (
  source TEXT NOT NULL,
  mint TEXT NOT NULL,
  signal_at BIGINT NOT NULL,
  horizon_hours INTEGER NOT NULL CHECK (horizon_hours BETWEEN 1 AND 168),
  score NUMERIC(10,4) NOT NULL,
  entry_observed_at BIGINT,
  entry_views BIGINT,
  exit_observed_at BIGINT,
  exit_views BIGINT,
  attention_change_pct NUMERIC(14,4),
  outcome_status TEXT NOT NULL CHECK (
    outcome_status IN ('ready','pending','missing_entry','missing_exit','low_baseline')
  ),
  details JSONB NOT NULL DEFAULT '{}'::JSONB,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source, mint, signal_at, horizon_hours)
);

CREATE INDEX IF NOT EXISTS idx_signal_quality_source_horizon_time
  ON signal_quality_outcomes(source, horizon_hours, signal_at DESC);
CREATE INDEX IF NOT EXISTS idx_signal_quality_status_time
  ON signal_quality_outcomes(outcome_status, signal_at DESC);

CREATE OR REPLACE FUNCTION refresh_signal_quality_outcomes(
  p_from BIGINT DEFAULT NULL,
  p_to BIGINT DEFAULT NULL,
  p_horizons INTEGER[] DEFAULT ARRAY[6, 24]
) RETURNS INTEGER AS $$
DECLARE
  from_ts BIGINT := COALESCE(p_from, (EXTRACT(EPOCH FROM NOW()) * 1000 - 90 * 86400000)::BIGINT);
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
    SELECT s.source, s.mint, s.signal_at, s.score, s.details, h.horizon_hours
    FROM signal_history s
    CROSS JOIN horizons h
    WHERE s.signal_at >= from_ts AND s.signal_at < to_ts
  ),
  observations AS (
    SELECT c.*,
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
        AND a.observed_at >= c.signal_at - 3600000
      ORDER BY a.observed_at DESC
      LIMIT 1
    ) e ON TRUE
    LEFT JOIN LATERAL (
      SELECT a.observed_at, a.views
      FROM mint_attention_snapshots a
      WHERE a.mint = c.mint
        AND a.observed_at >= c.signal_at + (c.horizon_hours * 3600000)::BIGINT
        AND a.observed_at < c.signal_at + ((c.horizon_hours + 1) * 3600000)::BIGINT
      ORDER BY a.observed_at ASC
      LIMIT 1
    ) x ON TRUE
  )
  INSERT INTO signal_quality_outcomes (
    source, mint, signal_at, horizon_hours, score,
    entry_observed_at, entry_views, exit_observed_at, exit_views,
    attention_change_pct, outcome_status, details, evaluated_at
  )
  SELECT o.source, o.mint, o.signal_at, o.horizon_hours, o.score,
    o.entry_observed_at, o.entry_views, o.exit_observed_at, o.exit_views,
    CASE
      WHEN o.entry_views >= 100 AND o.exit_views IS NOT NULL
      THEN ROUND(((o.exit_views - o.entry_views)::NUMERIC / NULLIF(o.entry_views, 0)) * 100, 4)
      ELSE NULL
    END,
    CASE
      WHEN o.entry_observed_at IS NULL THEN 'missing_entry'
      WHEN o.entry_views IS NULL OR o.entry_views < 100 THEN 'low_baseline'
      WHEN o.exit_observed_at IS NOT NULL THEN 'ready'
      WHEN now_ms < o.signal_at + ((o.horizon_hours + 1) * 3600000)::BIGINT THEN 'pending'
      ELSE 'missing_exit'
    END,
    jsonb_build_object(
      'metric_basis', 'observed_dataset_views_change_pct',
      'signal_details', COALESCE(o.details, '{}'::JSONB),
      'entry_max_age_ms', 3600000,
      'outcome_window_start', o.signal_at + (o.horizon_hours * 3600000)::BIGINT,
      'outcome_window_end_exclusive', o.signal_at + ((o.horizon_hours + 1) * 3600000)::BIGINT,
      'minimum_entry_views', 100
    ),
    now()
  FROM observations o
  ON CONFLICT (source, mint, signal_at, horizon_hours) DO UPDATE SET
    score = EXCLUDED.score,
    entry_observed_at = EXCLUDED.entry_observed_at,
    entry_views = EXCLUDED.entry_views,
    exit_observed_at = EXCLUDED.exit_observed_at,
    exit_views = EXCLUDED.exit_views,
    attention_change_pct = EXCLUDED.attention_change_pct,
    outcome_status = EXCLUDED.outcome_status,
    details = EXCLUDED.details,
    evaluated_at = EXCLUDED.evaluated_at;

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
    FILTER (WHERE outcome_status = 'ready'), 2) AS positive_attention_rate_pct
FROM signal_quality_outcomes
GROUP BY source, horizon_hours, day_start_ms, score_band;

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
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY attention_change_pct)
    FILTER (WHERE outcome_status = 'ready')::NUMERIC, 4) AS median_attention_change_pct,
  ROUND(100.0 * AVG(CASE WHEN attention_change_pct > 0 THEN 1.0 ELSE 0.0 END)
    FILTER (WHERE outcome_status = 'ready'), 2) AS positive_attention_rate_pct
FROM signal_quality_outcomes
GROUP BY source, horizon_hours, score_band;

INSERT INTO retention_policies (table_name, retention_days, archive_to_s3)
VALUES ('signal_quality_outcomes', 365, FALSE)
ON CONFLICT (table_name) DO NOTHING;
