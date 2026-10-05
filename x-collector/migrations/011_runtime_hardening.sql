-- Runtime hardening and compatibility migration for the supplied source snapshot.
-- Apply after migrations 001..010. This migration intentionally keeps the old
-- return-named columns for compatibility while new code uses explicitly named
-- social-attention metrics.

ALTER TABLE x_accounts
  ADD COLUMN IF NOT EXISTS account_busy_until BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS account_claimed_by TEXT;
CREATE INDEX IF NOT EXISTS idx_x_accounts_busy ON x_accounts(status, account_busy_until, tier);

ALTER TABLE outbox
  ADD COLUMN IF NOT EXISTS available_at BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS claimed_at BIGINT,
  ADD COLUMN IF NOT EXISTS claimed_by TEXT,
  ADD COLUMN IF NOT EXISTS failed_at BIGINT;
UPDATE outbox SET available_at = created_at WHERE available_at = 0;
DROP INDEX IF EXISTS idx_outbox_unpublished;
CREATE INDEX idx_outbox_unpublished
  ON outbox(available_at, created_at, id)
  WHERE published_at IS NULL AND failed_at IS NULL;

-- Preserve the observed state needed for honest forward-looking evaluation.
-- These begin at migration time; historical values are not fabricated/backfilled.
CREATE TABLE IF NOT EXISTS mint_attention_snapshots (
  mint TEXT NOT NULL,
  observed_at BIGINT NOT NULL,
  tweets INTEGER NOT NULL,
  authors INTEGER NOT NULL,
  views BIGINT NOT NULL,
  likes BIGINT NOT NULL,
  retweets BIGINT NOT NULL,
  PRIMARY KEY (mint, observed_at)
);
CREATE INDEX IF NOT EXISTS idx_attention_observed ON mint_attention_snapshots(observed_at DESC);

CREATE TABLE IF NOT EXISTS signal_history (
  source TEXT NOT NULL CHECK (source IN ('hype','ultra','early_signal')),
  mint TEXT NOT NULL,
  signal_at BIGINT NOT NULL,
  score NUMERIC(10,4) NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::JSONB,
  PRIMARY KEY (source, mint, signal_at)
);
CREATE INDEX IF NOT EXISTS idx_signal_history_time ON signal_history(source, signal_at DESC, mint);

UPDATE strategies SET rule_sql =
  'SELECT mint, signal_at, score FROM signal_history WHERE source = ''hype'' AND score >= 60'
WHERE name = 'hype_gt_60';
UPDATE strategies SET rule_sql =
  'SELECT mint, signal_at, score FROM signal_history WHERE source = ''ultra'' AND score >= 70'
WHERE name = 'ultra_gt_70';
UPDATE strategies SET rule_sql =
  'SELECT mint, signal_at, score FROM signal_history WHERE source = ''early_signal'' AND score >= 60'
WHERE name = 'early_signal';

INSERT INTO retention_policies (table_name, retention_days, archive_to_s3)
VALUES
  ('mint_attention_snapshots', 180, FALSE), ('signal_history', 90, FALSE),
  ('mint_metrics_1m', 14, FALSE), ('mint_metrics_1h', 180, FALSE),
  ('mint_metrics_1d', 1825, FALSE), ('mint_metrics_1w', 3650, FALSE),
  ('author_metrics_1d', 365, FALSE), ('ml_feature_snapshots', 365, FALSE)
ON CONFLICT (table_name) DO NOTHING;

CREATE OR REPLACE FUNCTION capture_mint_attention_snapshots() RETURNS INTEGER AS $$
DECLARE captured BIGINT := (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT; cnt INTEGER;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('capture_mint_attention_snapshots')::BIGINT) THEN RETURN 0; END IF;
  INSERT INTO mint_attention_snapshots (mint, observed_at, tweets, authors, views, likes, retweets)
  SELECT l.mint, captured,
    COUNT(DISTINCT t.tweet_id)::INTEGER,
    COUNT(DISTINCT t.handle)::INTEGER,
    COALESCE(SUM(t.views), 0)::BIGINT,
    COALESCE(SUM(t.likes), 0)::BIGINT,
    COALESCE(SUM(t.retweets), 0)::BIGINT
  FROM tweet_token_links l
  JOIN twitter_tweets t ON t.tweet_id = l.tweet_id
  GROUP BY l.mint
  ON CONFLICT (mint, observed_at) DO UPDATE SET
    tweets=EXCLUDED.tweets, authors=EXCLUDED.authors, views=EXCLUDED.views,
    likes=EXCLUDED.likes, retweets=EXCLUDED.retweets;
  GET DIAGNOSTICS cnt = ROW_COUNT;
  RETURN cnt;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION capture_signal_history() RETURNS INTEGER AS $$
DECLARE captured BIGINT := (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT; cnt INTEGER;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('capture_signal_history')::BIGINT) THEN RETURN 0; END IF;
  WITH current_signals AS (
    SELECT 'hype'::TEXT AS source, h.mint, h.hype_score::NUMERIC AS score,
           jsonb_build_object('delta_1h', h.delta_1h, 'velocity', h.velocity) AS details
    FROM mint_hype_scores h
    UNION ALL
    SELECT 'ultra'::TEXT, u.mint, u.ultra_score::NUMERIC,
           COALESCE(u.components, '{}'::JSONB)
    FROM mint_ultra_scores u
    UNION ALL
    SELECT 'early_signal'::TEXT, e.mint, e.signal_strength::NUMERIC,
           jsonb_build_object('hype_score', e.hype_score, 'last_30m', e.last_30m,
                              'velocity_x', e.velocity_x)
    FROM v_early_signals e
    WHERE e.signal_strength IS NOT NULL
  ), point_in_time AS (
    SELECT s.source, s.mint, s.score,
           s.details || jsonb_build_object('features', to_jsonb(f)) AS details
    FROM current_signals s
    CROSS JOIN LATERAL extract_features(s.mint, captured) f
  )
  INSERT INTO signal_history (source, mint, signal_at, score, details)
  SELECT source, mint, captured, score, details FROM point_in_time
  ON CONFLICT (source, mint, signal_at) DO UPDATE SET
    score=EXCLUDED.score, details=EXCLUDED.details;
  GET DIAGNOSTICS cnt = ROW_COUNT;
  RETURN cnt;
END $$ LANGUAGE plpgsql;

-- Rebuild hourly metrics from source tweets. The previous snapshot omitted the
-- producer entirely, leaving hype, anomaly, and time-series consumers stale.
CREATE OR REPLACE FUNCTION rebuild_mint_metrics_1h(
  p_from BIGINT DEFAULT NULL, p_to BIGINT DEFAULT NULL
) RETURNS INTEGER AS $$
DECLARE
  from_ts BIGINT := COALESCE((p_from / 3600000) * 3600000, ((EXTRACT(EPOCH FROM NOW()) * 1000 - 7 * 86400000) / 3600000)::BIGINT * 3600000);
  to_ts BIGINT := COALESCE(p_to, (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT);
  cnt INTEGER;
BEGIN
  IF from_ts >= to_ts THEN RAISE EXCEPTION 'p_from must be earlier than p_to'; END IF;

  INSERT INTO mint_metrics_1h (
    mint, bucket, tweets, authors, verified, views, likes, retweets,
    sentiment, stddev_sentiment, spam_count, scam_count
  )
  SELECT l.mint,
    (t.posted_at / 3600000) * 3600000 AS bucket,
    COUNT(DISTINCT t.tweet_id)::INTEGER,
    COUNT(DISTINCT t.handle)::INTEGER,
    COUNT(DISTINCT t.handle) FILTER (WHERE t.is_verified)::INTEGER,
    COALESCE(SUM(t.views), 0)::BIGINT,
    COALESCE(SUM(t.likes), 0)::BIGINT,
    COALESCE(SUM(t.retweets), 0)::BIGINT,
    ROUND(AVG(s.score), 4),
    ROUND(STDDEV_POP(s.score), 4),
    COUNT(DISTINCT t.tweet_id) FILTER (WHERE tox.spam_score > 0.7)::INTEGER,
    COUNT(DISTINCT t.tweet_id) FILTER (WHERE tox.scam_score > 0.7)::INTEGER
  FROM tweet_token_links l
  JOIN twitter_tweets t ON t.tweet_id = l.tweet_id
  LEFT JOIN tweet_sentiment s ON s.tweet_id = t.tweet_id
  LEFT JOIN tweet_toxicity tox ON tox.tweet_id = t.tweet_id
  WHERE t.posted_at IS NOT NULL AND t.posted_at >= from_ts AND t.posted_at < to_ts
  GROUP BY l.mint, bucket
  ON CONFLICT (mint, bucket) DO UPDATE SET
    tweets = EXCLUDED.tweets,
    authors = EXCLUDED.authors,
    verified = EXCLUDED.verified,
    views = EXCLUDED.views,
    likes = EXCLUDED.likes,
    retweets = EXCLUDED.retweets,
    sentiment = EXCLUDED.sentiment,
    stddev_sentiment = EXCLUDED.stddev_sentiment,
    spam_count = EXCLUDED.spam_count,
    scam_count = EXCLUDED.scam_count;

  GET DIAGNOSTICS cnt = ROW_COUNT;
  RETURN cnt;
END $$ LANGUAGE plpgsql;

-- Daily rollup uses distinct authors across the full day, not MAX(hourly authors).
CREATE OR REPLACE FUNCTION rollup_mint_1d(p_from BIGINT DEFAULT NULL, p_to BIGINT DEFAULT NULL)
RETURNS INTEGER AS $$
DECLARE
  from_ts BIGINT := COALESCE((p_from / 86400000) * 86400000, (EXTRACT(EPOCH FROM NOW()) * 1000 - 7 * 86400000)::BIGINT);
  to_ts BIGINT := COALESCE(p_to, (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT);
  cnt INTEGER;
BEGIN
  IF from_ts >= to_ts THEN RAISE EXCEPTION 'p_from must be earlier than p_to'; END IF;

  WITH base AS (
    SELECT l.mint, t.tweet_id, t.handle, t.views, t.likes, t.retweets,
           t.is_verified, t.posted_at, s.score,
           (t.posted_at / 86400000) * 86400000 AS day_bucket,
           (t.posted_at / 3600000) * 3600000 AS hour_bucket
    FROM tweet_token_links l
    JOIN twitter_tweets t ON t.tweet_id = l.tweet_id
    LEFT JOIN tweet_sentiment s ON s.tweet_id = t.tweet_id
    WHERE t.posted_at IS NOT NULL AND t.posted_at >= from_ts AND t.posted_at < to_ts
  ), hourly AS (
    SELECT mint, day_bucket, hour_bucket, COUNT(DISTINCT tweet_id)::INTEGER AS tweets
    FROM base GROUP BY mint, day_bucket, hour_bucket
  ), daily AS (
    SELECT b.mint, b.day_bucket,
      COUNT(DISTINCT b.tweet_id)::INTEGER AS tweets,
      COUNT(DISTINCT b.handle)::INTEGER AS authors,
      COUNT(DISTINCT b.handle) FILTER (WHERE b.is_verified)::INTEGER AS verified,
      COALESCE(SUM(b.views), 0)::BIGINT AS views,
      COALESCE(SUM(b.likes), 0)::BIGINT AS likes,
      COALESCE(SUM(b.retweets), 0)::BIGINT AS retweets,
      ROUND(AVG(b.score), 4) AS sentiment,
      (SELECT (h.hour_bucket / 3600000 % 24)::INTEGER
       FROM hourly h WHERE h.mint = b.mint AND h.day_bucket = b.day_bucket
       ORDER BY h.tweets DESC, h.hour_bucket ASC LIMIT 1) AS peak_hour,
      (SELECT COUNT(*)::INTEGER FROM hourly h
       WHERE h.mint = b.mint AND h.day_bucket = b.day_bucket AND h.tweets >= 100) AS burst_count
    FROM base b GROUP BY b.mint, b.day_bucket
  )
  INSERT INTO mint_metrics_1d
    (mint, bucket, tweets, authors, verified, views, likes, retweets, sentiment, peak_hour, burst_count)
  SELECT mint, day_bucket, tweets, authors, verified, views, likes, retweets, sentiment, peak_hour, burst_count
  FROM daily
  ON CONFLICT (mint, bucket) DO UPDATE SET
    tweets=EXCLUDED.tweets, authors=EXCLUDED.authors, verified=EXCLUDED.verified,
    views=EXCLUDED.views, likes=EXCLUDED.likes, retweets=EXCLUDED.retweets,
    sentiment=EXCLUDED.sentiment, peak_hour=EXCLUDED.peak_hour, burst_count=EXCLUDED.burst_count;

  GET DIAGNOSTICS cnt = ROW_COUNT;
  RETURN cnt;
END $$ LANGUAGE plpgsql;

-- Weekly mint metrics and daily author metrics are query-backed tables; maintain them explicitly.
CREATE OR REPLACE FUNCTION rollup_mint_1w(p_from BIGINT DEFAULT NULL, p_to BIGINT DEFAULT NULL)
RETURNS INTEGER AS $$
DECLARE
  from_ts BIGINT := COALESCE((p_from / 604800000) * 604800000, (EXTRACT(EPOCH FROM NOW()) * 1000 - 90 * 86400000)::BIGINT);
  to_ts BIGINT := COALESCE(p_to, (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT);
  cnt INTEGER;
BEGIN
  IF from_ts >= to_ts THEN RAISE EXCEPTION 'p_from must be earlier than p_to'; END IF;
  INSERT INTO mint_metrics_1w (mint, bucket, tweets, authors, views, sentiment)
  SELECT l.mint, (t.posted_at / 604800000) * 604800000,
    COUNT(DISTINCT t.tweet_id)::INTEGER,
    COUNT(DISTINCT t.handle)::INTEGER,
    COALESCE(SUM(t.views), 0)::BIGINT,
    ROUND(AVG(s.score), 4)
  FROM tweet_token_links l
  JOIN twitter_tweets t ON t.tweet_id = l.tweet_id
  LEFT JOIN tweet_sentiment s ON s.tweet_id = t.tweet_id
  WHERE t.posted_at IS NOT NULL AND t.posted_at >= from_ts AND t.posted_at < to_ts
  GROUP BY l.mint, (t.posted_at / 604800000) * 604800000
  ON CONFLICT (mint, bucket) DO UPDATE SET
    tweets=EXCLUDED.tweets, authors=EXCLUDED.authors,
    views=EXCLUDED.views, sentiment=EXCLUDED.sentiment;
  GET DIAGNOSTICS cnt = ROW_COUNT;
  RETURN cnt;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION rebuild_author_metrics_1d(p_from BIGINT DEFAULT NULL, p_to BIGINT DEFAULT NULL)
RETURNS INTEGER AS $$
DECLARE
  from_ts BIGINT := COALESCE((p_from / 86400000) * 86400000, (EXTRACT(EPOCH FROM NOW()) * 1000 - 90 * 86400000)::BIGINT);
  to_ts BIGINT := COALESCE(p_to, (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT);
  cnt INTEGER;
BEGIN
  IF from_ts >= to_ts THEN RAISE EXCEPTION 'p_from must be earlier than p_to'; END IF;
  WITH base AS (
    SELECT t.tweet_id, t.handle, t.views, t.likes, t.retweets, t.posted_at,
           s.score, (t.posted_at / 86400000) * 86400000 AS day_bucket
    FROM twitter_tweets t
    LEFT JOIN tweet_sentiment s ON s.tweet_id = t.tweet_id
    WHERE t.posted_at IS NOT NULL AND t.posted_at >= from_ts AND t.posted_at < to_ts
  ), daily AS (
    SELECT handle, day_bucket,
      COUNT(DISTINCT tweet_id)::INTEGER AS tweets,
      COALESCE(SUM(views),0)::BIGINT AS views,
      COALESCE(SUM(likes),0)::BIGINT AS likes,
      COALESCE(SUM(retweets),0)::BIGINT AS retweets,
      ROUND(AVG(score),4) AS sentiment
    FROM base GROUP BY handle, day_bucket
  ), mint_counts AS (
    SELECT b.handle, b.day_bucket, COUNT(DISTINCT l.mint)::INTEGER AS mints
    FROM base b JOIN tweet_token_links l ON l.tweet_id=b.tweet_id
    GROUP BY b.handle, b.day_bucket
  )
  INSERT INTO author_metrics_1d
    (handle, bucket, tweets, views, likes, retweets, mints, sentiment)
  SELECT d.handle, d.day_bucket, d.tweets, d.views, d.likes, d.retweets,
         COALESCE(m.mints,0), d.sentiment
  FROM daily d LEFT JOIN mint_counts m USING (handle, day_bucket)
  ON CONFLICT (handle, bucket) DO UPDATE SET
    tweets=EXCLUDED.tweets, views=EXCLUDED.views, likes=EXCLUDED.likes,
    retweets=EXCLUDED.retweets, mints=EXCLUDED.mints, sentiment=EXCLUDED.sentiment;
  GET DIAGNOSTICS cnt = ROW_COUNT;
  RETURN cnt;
END $$ LANGUAGE plpgsql;

-- Milestones are written only after their thresholds are met.
CREATE OR REPLACE FUNCTION check_milestones() RETURNS TRIGGER AS $$
DECLARE cnt INTEGER; has_verified BOOLEAN;
BEGIN
  SELECT COUNT(DISTINCT t.tweet_id), COALESCE(BOOL_OR(t.is_verified), FALSE)
  INTO cnt, has_verified
  FROM tweet_token_links l
  JOIN twitter_tweets t ON t.tweet_id = l.tweet_id
  WHERE l.mint = NEW.mint;

  IF cnt >= 10 THEN
    INSERT INTO mint_milestones (mint, milestone, value, reached_at)
    VALUES (NEW.mint, 'first_10_tweets', cnt, (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT)
    ON CONFLICT (mint, milestone) DO NOTHING;
  END IF;
  IF cnt >= 100 THEN
    INSERT INTO mint_milestones (mint, milestone, value, reached_at)
    VALUES (NEW.mint, 'first_100_tweets', cnt, (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT)
    ON CONFLICT (mint, milestone) DO NOTHING;
  END IF;
  IF cnt >= 1000 THEN
    INSERT INTO mint_milestones (mint, milestone, value, reached_at)
    VALUES (NEW.mint, 'first_1000_tweets', cnt, (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT)
    ON CONFLICT (mint, milestone) DO NOTHING;
  END IF;
  IF has_verified THEN
    INSERT INTO mint_milestones (mint, milestone, value, reached_at)
    VALUES (NEW.mint, 'first_verified', 1, (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT)
    ON CONFLICT (mint, milestone) DO NOTHING;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Enforce one auto-generated viral event per mint/hour and emit an outbox event
-- only when a new event is actually inserted.
DELETE FROM mint_events a
USING mint_events b
WHERE a.mint = b.mint AND a.event_type = b.event_type AND a.event_at = b.event_at
  AND a.source = 'auto' AND b.source = 'auto' AND a.event_type = 'viral'
  AND a.id > b.id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_mint_events_viral_hour
  ON mint_events(mint, event_type, event_at)
  WHERE source = 'auto' AND event_type = 'viral';

CREATE OR REPLACE FUNCTION detect_viral_events() RETURNS INTEGER AS $$
DECLARE cnt INTEGER := 0; rec RECORD; inserted_id BIGINT; detected BIGINT;
BEGIN
  detected := (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT;
  FOR rec IN
    SELECT mint, hour_bucket, tweets FROM (
      SELECT l.mint, (t.posted_at / 3600000)::BIGINT AS hour_bucket,
        COUNT(DISTINCT t.tweet_id) AS tweets
      FROM tweet_token_links l
      JOIN twitter_tweets t ON t.tweet_id = l.tweet_id
      WHERE t.posted_at > detected - 86400000
      GROUP BY l.mint, hour_bucket
    ) x WHERE x.tweets >= 100
  LOOP
    inserted_id := NULL;
    INSERT INTO mint_events (mint, event_type, severity, detected_at, event_at, source, payload)
    VALUES (
      rec.mint, 'viral', 4, detected, rec.hour_bucket * 3600000, 'auto',
      jsonb_build_object('tweets_in_hour', rec.tweets)
    )
    ON CONFLICT (mint, event_type, event_at)
      WHERE source = 'auto' AND event_type = 'viral'
    DO NOTHING
    RETURNING id INTO inserted_id;

    IF inserted_id IS NOT NULL THEN
      INSERT INTO outbox (topic, payload, created_at, available_at)
      VALUES (
        'mint.viral',
        jsonb_build_object('mint', rec.mint, 'hour_bucket', rec.hour_bucket, 'tweets', rec.tweets),
        detected, detected
      );
      cnt := cnt + 1;
    END IF;
  END LOOP;
  RETURN cnt;
END $$ LANGUAGE plpgsql;

-- The model target and stored standardization are explicit. Legacy label columns
-- are retained but treated as deprecated social-view proxies, not token returns.
ALTER TABLE ml_feature_snapshots
  ADD COLUMN IF NOT EXISTS label_views_change_pct NUMERIC(12,4),
  ADD COLUMN IF NOT EXISTS label_views_growth_50 BOOLEAN,
  ADD COLUMN IF NOT EXISTS label_basis TEXT NOT NULL DEFAULT 'legacy_unknown';
UPDATE ml_feature_snapshots SET label_basis = 'legacy_social_proxy'
WHERE label_basis = 'legacy_unknown';
DELETE FROM ml_feature_snapshots a
USING ml_feature_snapshots b
WHERE a.mint = b.mint AND a.snapshot_at = b.snapshot_at AND a.horizon_h = b.horizon_h
  AND a.id < b.id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_mlfeat_snapshot_unique
  ON ml_feature_snapshots(mint, snapshot_at, horizon_h);
DROP INDEX IF EXISTS idx_mlfeat_label;
CREATE INDEX idx_mlfeat_label ON ml_feature_snapshots(label_basis, horizon_h, label_views_growth_50);

ALTER TABLE ml_models
  ADD COLUMN IF NOT EXISTS target_name TEXT NOT NULL DEFAULT 'observed_dataset_views_growth_50_pct',
  ADD COLUMN IF NOT EXISTS feature_means NUMERIC(12,8)[],
  ADD COLUMN IF NOT EXISTS feature_scales NUMERIC(12,8)[];
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY horizon_h ORDER BY trained_at DESC, id DESC) AS rn
  FROM ml_models WHERE is_active
)
UPDATE ml_models SET is_active = FALSE
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
UPDATE ml_models SET is_active = FALSE
WHERE is_active AND (feature_means IS NULL OR feature_scales IS NULL);
DROP INDEX IF EXISTS idx_ml_models_one_active;
CREATE UNIQUE INDEX idx_ml_models_one_active ON ml_models(horizon_h) WHERE is_active;
COMMENT ON COLUMN ml_feature_snapshots.label_return IS
  'Deprecated legacy label; not used to train the point-in-time observed-dataset model.';
COMMENT ON COLUMN ml_feature_snapshots.label_win IS
  'Deprecated legacy label; not used to train the point-in-time observed-dataset model.';
COMMENT ON COLUMN backtest_trades.return_pct IS
  'Deprecated legacy field; old values were social-view changes and are not financial returns.';
COMMENT ON COLUMN backtest_runs.avg_return_pct IS
  'Deprecated legacy field; do not interpret as market return or trading P&L.';

-- Keep only explicitly named metrics for new backtest runs.
ALTER TABLE backtest_runs
  ADD COLUMN IF NOT EXISTS metric_basis TEXT NOT NULL DEFAULT 'legacy_unknown',
  ADD COLUMN IF NOT EXISTS avg_views_change_pct NUMERIC(10,4),
  ADD COLUMN IF NOT EXISTS median_views_change_pct NUMERIC(10,4),
  ADD COLUMN IF NOT EXISTS positive_attention_rate NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS min_views_change_pct NUMERIC(10,4);
ALTER TABLE backtest_trades
  ADD COLUMN IF NOT EXISTS views_change_pct NUMERIC(10,4);
UPDATE backtest_runs
SET metric_basis = 'legacy_social_proxy',
    notes = CONCAT_WS(' ', notes,
      'Legacy metrics were derived from social views, not token prices; not financial returns or trading P&L.')
WHERE metric_basis = 'legacy_unknown';
COMMENT ON COLUMN backtest_trades.views_change_pct IS
  'Percentage change in one-hour aggregate tweet views; social-attention proxy only.';

-- Point-in-time features use only tweets collected/linked/scored by p_at and the
-- latest aggregate attention snapshot that existed by p_at.
CREATE OR REPLACE FUNCTION extract_features(p_mint TEXT, p_at BIGINT)
RETURNS TABLE(
  f_velocity NUMERIC, f_sentiment NUMERIC, f_reach_log NUMERIC,
  f_kol_count INTEGER, f_coord_count INTEGER, f_unique_authors INTEGER,
  f_burst_count INTEGER, f_sent_weighted NUMERIC, f_lead_ratio NUMERIC,
  f_verified_ratio NUMERIC, f_spam_ratio NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  WITH tweets_window AS (
    SELECT t.tweet_id, t.handle, t.is_verified, t.text, t.posted_at
    FROM tweet_token_links l
    JOIN twitter_tweets t ON t.tweet_id = l.tweet_id
    WHERE l.mint = p_mint
      AND l.linked_at <= p_at
      AND t.first_seen_at <= p_at
      AND t.posted_at IS NOT NULL
      AND t.posted_at <= p_at
      AND t.posted_at > p_at - 86400000
  ), hourly AS (
    SELECT
      COUNT(*) FILTER (WHERE posted_at > p_at - 3600000)::NUMERIC AS last_h,
      COUNT(*) FILTER (WHERE posted_at <= p_at - 3600000)::NUMERIC / 23.0 AS avg_h
    FROM tweets_window
  ), observed AS (
    SELECT a.views
    FROM mint_attention_snapshots a
    WHERE a.mint = p_mint AND a.observed_at <= p_at
    ORDER BY a.observed_at DESC LIMIT 1
  )
  SELECT
    CASE WHEN h.avg_h > 0 THEN LEAST(h.last_h / h.avg_h, 10) ELSE h.last_h END,
    COALESCE((SELECT AVG(s.score) FROM tweet_sentiment s
              JOIN tweets_window tw ON tw.tweet_id = s.tweet_id
              WHERE s.scored_at <= p_at), 0),
    COALESCE(LOG(GREATEST((SELECT o.views FROM observed o), 1)), 0),
    COALESCE(COUNT(DISTINCT CASE WHEN t.is_verified THEN t.handle END), 0)::INTEGER,
    COALESCE((
      SELECT COUNT(*) FROM (
        SELECT md5(regexp_replace(lower(tw2.text), '\s+', ' ', 'g')) AS h
        FROM tweets_window tw2 WHERE length(tw2.text) > 30
        GROUP BY h HAVING COUNT(*) >= 3
      ) c
    ), 0)::INTEGER,
    COUNT(DISTINCT t.handle)::INTEGER,
    COALESCE((
      SELECT COUNT(*) FROM (
        SELECT (tw3.posted_at / 3600000)::BIGINT AS h
        FROM tweets_window tw3 GROUP BY h HAVING COUNT(*) >= 10
      ) b
    ), 0)::INTEGER,
    COALESCE((
      SELECT SUM(s.score * COALESCE(r.reputation_score, 50) / 50.0)
             / NULLIF(SUM(COALESCE(r.reputation_score, 50) / 50.0), 0)
      FROM tweet_sentiment s
      JOIN tweets_window tw4 ON tw4.tweet_id = s.tweet_id
      LEFT JOIN author_reputation r ON r.handle = tw4.handle AND r.updated_at <= p_at
      WHERE s.scored_at <= p_at
    ), 0),
    COALESCE((
      SELECT AVG(CASE WHEN ls.lead_ratio >= 0.3 THEN 1.0 ELSE 0.0 END)
      FROM tweets_window tw5
      LEFT JOIN author_lead_stats ls ON ls.handle = tw5.handle AND ls.updated_at <= p_at
    ), 0),
    CASE WHEN COUNT(*) > 0
         THEN COUNT(DISTINCT CASE WHEN t.is_verified THEN t.handle END)::NUMERIC / COUNT(DISTINCT t.handle)
         ELSE 0 END,
    COALESCE((
      SELECT AVG(tx.spam_score) FROM tweet_toxicity tx
      JOIN tweets_window tw6 ON tw6.tweet_id = tx.tweet_id
      WHERE tx.scored_at <= p_at
    ), 0)
  FROM tweets_window t
  CROSS JOIN hourly h
  GROUP BY h.last_h, h.avg_h;
END $$ LANGUAGE plpgsql STABLE;

-- Training examples come only from captured historical signals and aggregate
-- snapshots. No post-hoc current counters are used as historical labels.
CREATE OR REPLACE FUNCTION build_training_data(p_horizon_h INT DEFAULT 6, p_step_h INT DEFAULT 12)
RETURNS INTEGER AS $$
DECLARE
  cnt INTEGER := 0;
  inserted INTEGER;
  rec RECORD;
  feat RECORD;
  target_at BIGINT;
  views_change_pct NUMERIC;
  views_now BIGINT;
  views_then BIGINT;
BEGIN
  IF p_horizon_h < 1 OR p_horizon_h > 720 OR p_step_h < 1 OR p_step_h > 720 THEN
    RAISE EXCEPTION 'Invalid training horizon or step';
  END IF;

  FOR rec IN
    WITH ranked AS (
      SELECT mint, signal_at, details,
             ROW_NUMBER() OVER (PARTITION BY mint ORDER BY signal_at) AS rn
      FROM signal_history WHERE source = 'hype'
    )
    SELECT mint, signal_at, details FROM ranked
    WHERE MOD(rn - 1, p_step_h::BIGINT * 6) = 0
    ORDER BY signal_at, mint
  LOOP
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM ml_feature_snapshots
      WHERE mint = rec.mint AND snapshot_at = rec.signal_at AND horizon_h = p_horizon_h
    );

    views_now := NULL;
    views_then := NULL;
    target_at := rec.signal_at + p_horizon_h::BIGINT * 3600000;

    SELECT a.views INTO views_now
    FROM mint_attention_snapshots a
    WHERE a.mint = rec.mint AND a.observed_at <= rec.signal_at
      AND a.observed_at >= rec.signal_at - 3600000
    ORDER BY a.observed_at DESC LIMIT 1;
    CONTINUE WHEN views_now IS NULL OR views_now < 100;

    SELECT a.views INTO views_then
    FROM mint_attention_snapshots a
    WHERE a.mint = rec.mint AND a.observed_at >= target_at
      AND a.observed_at < target_at + 3600000
    ORDER BY a.observed_at ASC LIMIT 1;
    CONTINUE WHEN views_then IS NULL;

    views_change_pct := ROUND((views_then - views_now)::NUMERIC / NULLIF(views_now, 0) * 100, 4);
    CONTINUE WHEN rec.details->'features' IS NULL;
    SELECT * INTO feat
    FROM jsonb_to_record(rec.details->'features') AS f(
      f_velocity NUMERIC, f_sentiment NUMERIC, f_reach_log NUMERIC,
      f_kol_count INTEGER, f_coord_count INTEGER, f_unique_authors INTEGER,
      f_burst_count INTEGER, f_sent_weighted NUMERIC, f_lead_ratio NUMERIC,
      f_verified_ratio NUMERIC, f_spam_ratio NUMERIC
    );

    INSERT INTO ml_feature_snapshots (
      mint, snapshot_at, horizon_h,
      f_velocity, f_sentiment, f_reach_log, f_kol_count, f_coord_count,
      f_unique_authors, f_burst_count, f_sent_weighted, f_lead_ratio,
      f_verified_ratio, f_spam_ratio, label_views_change_pct, label_views_growth_50,
      label_basis, created_at
    ) VALUES (
      rec.mint, rec.signal_at, p_horizon_h,
      feat.f_velocity, feat.f_sentiment, feat.f_reach_log, feat.f_kol_count, feat.f_coord_count,
      feat.f_unique_authors, feat.f_burst_count, feat.f_sent_weighted, feat.f_lead_ratio,
      feat.f_verified_ratio, feat.f_spam_ratio, views_change_pct, views_change_pct >= 50,
      'observed_dataset_views', (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    ) ON CONFLICT (mint, snapshot_at, horizon_h) DO NOTHING;
    GET DIAGNOSTICS inserted = ROW_COUNT;
    cnt := cnt + inserted;
  END LOOP;
  RETURN cnt;
END $$ LANGUAGE plpgsql;

-- PageRank treats shared-mint co-mentions as an undirected graph and serializes
-- concurrent rebuilds to avoid two workers clobbering the same result table.
CREATE OR REPLACE FUNCTION rebuild_pagerank(
  p_damping NUMERIC DEFAULT 0.85,
  p_iterations INT DEFAULT 20,
  p_min_weight INT DEFAULT 2
) RETURNS INTEGER AS $$
DECLARE iter INT := 0; cnt INTEGER; node_count INTEGER;
BEGIN
  IF p_damping <= 0 OR p_damping >= 1 OR p_iterations < 1 OR p_iterations > 1000 OR p_min_weight < 1 THEN
    RAISE EXCEPTION 'Invalid PageRank parameters';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('rebuild-pagerank')::BIGINT);
  DROP TABLE IF EXISTS _pr_temp;
  DROP TABLE IF EXISTS _pr_next;

  CREATE TEMP TABLE _pr_temp ON COMMIT DROP AS
  WITH edges AS (
    SELECT source AS a, target AS b, weight FROM v_author_graph WHERE weight >= p_min_weight
    UNION ALL
    SELECT target AS a, source AS b, weight FROM v_author_graph WHERE weight >= p_min_weight
  ), nodes AS (
    SELECT a AS handle FROM edges UNION SELECT b FROM edges
  )
  SELECT handle, 1.0 / NULLIF(COUNT(*) OVER (), 0) AS pagerank FROM nodes;
  SELECT COUNT(*) INTO node_count FROM _pr_temp;

  IF node_count = 0 THEN
    DELETE FROM author_pagerank;
    DROP TABLE IF EXISTS _pr_temp;
    RETURN 0;
  END IF;

  CREATE INDEX ON _pr_temp(handle);
  WHILE iter < p_iterations LOOP
    DROP TABLE IF EXISTS _pr_next;
    CREATE TEMP TABLE _pr_next ON COMMIT DROP AS
    WITH edges AS (
      SELECT source AS a, target AS b, weight::NUMERIC FROM v_author_graph WHERE weight >= p_min_weight
      UNION ALL
      SELECT target AS a, source AS b, weight::NUMERIC FROM v_author_graph WHERE weight >= p_min_weight
    ), out_degrees AS (
      SELECT a, SUM(weight) AS total FROM edges GROUP BY a
    ), contributions AS (
      SELECT e.b AS handle, SUM(p.pagerank * e.weight / NULLIF(o.total, 0)) AS contrib
      FROM edges e
      JOIN _pr_temp p ON p.handle = e.a
      JOIN out_degrees o ON o.a = e.a
      GROUP BY e.b
    )
    SELECT p.handle,
      (1 - p_damping) / node_count + p_damping * COALESCE(c.contrib, 0) AS pagerank
    FROM _pr_temp p
    LEFT JOIN contributions c ON c.handle = p.handle;

    DROP TABLE _pr_temp;
    ALTER TABLE _pr_next RENAME TO _pr_temp;
    CREATE INDEX ON _pr_temp(handle);
    iter := iter + 1;
  END LOOP;

  DELETE FROM author_pagerank;
  INSERT INTO author_pagerank (handle, pagerank, degree_in, degree_out, iterations, computed_at)
  SELECT p.handle, p.pagerank,
    COALESCE((SELECT COUNT(*) FROM v_author_graph WHERE target = p.handle AND weight >= p_min_weight)
           + (SELECT COUNT(*) FROM v_author_graph WHERE source = p.handle AND weight >= p_min_weight), 0),
    COALESCE((SELECT COUNT(*) FROM v_author_graph WHERE source = p.handle AND weight >= p_min_weight)
           + (SELECT COUNT(*) FROM v_author_graph WHERE target = p.handle AND weight >= p_min_weight), 0),
    p_iterations, (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
  FROM _pr_temp p;
  GET DIAGNOSTICS cnt = ROW_COUNT;
  DROP TABLE IF EXISTS _pr_temp;
  RETURN cnt;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION apply_retention(dry_run BOOLEAN DEFAULT FALSE)
RETURNS TABLE(table_name TEXT, deleted BIGINT) AS $$
DECLARE
  pol RECORD;
  cnt BIGINT;
  cutoff_ms BIGINT;
  cutoff_day DATE;
  predicate TEXT;
  time_column TEXT;
  sql_text TEXT;
BEGIN
  FOR pol IN
    SELECT * FROM retention_policies WHERE enabled = TRUE ORDER BY table_name
  LOOP
    IF pol.retention_days < 1 OR pol.retention_days > 36500 THEN
      RAISE NOTICE 'Skipping invalid retention_days=% for table %', pol.retention_days, pol.table_name;
      CONTINUE;
    END IF;
    IF pol.archive_to_s3 AND NOT dry_run THEN
      RAISE NOTICE 'Skipping destructive retention for % because S3 archival is not implemented', pol.table_name;
      CONTINUE;
    END IF;
    cutoff_ms := (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
                 - (pol.retention_days::BIGINT * 86400000);
    cutoff_day := CURRENT_DATE - pol.retention_days;

    -- Explicit allow-list: never execute a table name supplied only by a policy row.
    time_column := CASE pol.table_name
      WHEN 'twitter_tweets' THEN 'first_seen_at'
      WHEN 'tweet_token_links' THEN 'linked_at'
      WHEN 'x_tasks' THEN 'created_at'
      WHEN 'x_tasks_dlq' THEN 'failed_at'
      WHEN 'outbox' THEN 'created_at'
      WHEN 'account_daily_stats' THEN 'day'
      WHEN 'account_state_log' THEN 'changed_at'
      WHEN 'session_rotations' THEN 'rotated_at'
      WHEN 'scrape_runs' THEN 'started_at'
      WHEN 'mint_attention_snapshots' THEN 'observed_at'
      WHEN 'signal_history' THEN 'signal_at'
      WHEN 'mint_metrics_1m' THEN 'bucket'
      WHEN 'mint_metrics_1h' THEN 'bucket'
      WHEN 'mint_metrics_1d' THEN 'bucket'
      WHEN 'mint_metrics_1w' THEN 'bucket'
      WHEN 'author_metrics_1d' THEN 'bucket'
      WHEN 'ml_feature_snapshots' THEN 'snapshot_at'
      ELSE NULL
    END;
    IF time_column IS NULL THEN
      RAISE NOTICE 'Skipping unsupported retention table: %', pol.table_name;
      CONTINUE;
    END IF;

    predicate := format('%I < $1', time_column);
    IF pol.table_name = 'x_tasks' THEN
      predicate := predicate || ' AND status IN (''done'', ''failed'')';
    ELSIF pol.table_name = 'outbox' THEN
      predicate := predicate || ' AND (published_at IS NOT NULL OR failed_at IS NOT NULL)';
    ELSIF pol.table_name = 'scrape_runs' THEN
      predicate := predicate || ' AND status IN (''done'', ''failed'', ''aborted'')';
    END IF;

    IF pol.table_name = 'account_daily_stats' THEN
      IF dry_run THEN
        sql_text := format('SELECT COUNT(*) FROM %I WHERE %s', pol.table_name, predicate);
        EXECUTE sql_text INTO cnt USING cutoff_day;
      ELSE
        sql_text := format(
          'WITH doomed AS (SELECT ctid FROM %I WHERE %s ORDER BY %I LIMIT 100000) DELETE FROM %I t USING doomed d WHERE t.ctid = d.ctid',
          pol.table_name, predicate, time_column, pol.table_name
        );
        EXECUTE sql_text USING cutoff_day;
        GET DIAGNOSTICS cnt = ROW_COUNT;
      END IF;
    ELSE
      IF dry_run THEN
        sql_text := format('SELECT COUNT(*) FROM %I WHERE %s', pol.table_name, predicate);
        EXECUTE sql_text INTO cnt USING cutoff_ms;
      ELSE
        sql_text := format(
          'WITH doomed AS (SELECT ctid FROM %I WHERE %s ORDER BY %I LIMIT 100000) DELETE FROM %I t USING doomed d WHERE t.ctid = d.ctid',
          pol.table_name, predicate, time_column, pol.table_name
        );
        EXECUTE sql_text USING cutoff_ms;
        GET DIAGNOSTICS cnt = ROW_COUNT;
        UPDATE retention_policies
        SET last_run_at = (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
        WHERE retention_policies.table_name = pol.table_name;
      END IF;
    END IF;

    IF pol.table_name = 'account_daily_stats' AND NOT dry_run THEN
      UPDATE retention_policies
      SET last_run_at = (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
      WHERE retention_policies.table_name = pol.table_name;
    END IF;

    table_name := pol.table_name;
    deleted := cnt;
    RETURN NEXT;
  END LOOP;
END $$ LANGUAGE plpgsql;

DROP FUNCTION IF EXISTS refresh_all_mvs();




-- Replace legacy training/inference and backtest routines for deployed schemas.
CREATE OR REPLACE FUNCTION train_logistic_regression(
  p_name TEXT, p_horizon_h INT DEFAULT 6,
  p_lr NUMERIC DEFAULT 0.01, p_epochs INT DEFAULT 500, p_l2 NUMERIC DEFAULT 0.001
) RETURNS BIGINT AS $$
DECLARE
  feature_names TEXT[] := ARRAY[
    'f_velocity','f_sentiment','f_reach_log','f_kol_count','f_coord_count',
    'f_unique_authors','f_burst_count','f_sent_weighted','f_lead_ratio',
    'f_verified_ratio','f_spam_ratio'
  ];
  n_features INT := array_length(feature_names, 1);
  coefs NUMERIC[] := ARRAY(SELECT 0.0 FROM generate_series(1, n_features));
  intercept NUMERIC := 0.0;
  epoch INT := 0;
  sample RECORD;
  feats NUMERIC[];
  z NUMERIC;
  p NUMERIC;
  grad NUMERIC;
  grad_i NUMERIC;
  train_count INT;
  test_count INT;
  train_acc NUMERIC;
  test_acc NUMERIC;
  train_ll NUMERIC;
  test_ll NUMERIC;
  model_id BIGINT;
  split_at BIGINT;
  i INT;
  m_rec RECORD;
  feature_means NUMERIC[];
  feature_scales NUMERIC[];
BEGIN
  IF p_horizon_h < 1 OR p_lr <= 0 OR p_epochs < 1 OR p_epochs > 10000 OR p_l2 < 0 THEN
    RAISE EXCEPTION 'Invalid training parameters';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('ml-model-' || p_horizon_h::TEXT)::BIGINT);

  SELECT PERCENTILE_CONT(0.8) WITHIN GROUP (ORDER BY snapshot_at) INTO split_at
  FROM ml_feature_snapshots
  WHERE horizon_h = p_horizon_h AND label_basis = 'observed_dataset_views' AND label_views_growth_50 IS NOT NULL;

  SELECT COUNT(*) INTO train_count FROM ml_feature_snapshots
  WHERE horizon_h = p_horizon_h AND label_basis = 'observed_dataset_views' AND label_views_growth_50 IS NOT NULL AND snapshot_at <= split_at;
  SELECT COUNT(*) INTO test_count FROM ml_feature_snapshots
  WHERE horizon_h = p_horizon_h AND label_basis = 'observed_dataset_views' AND label_views_growth_50 IS NOT NULL AND snapshot_at > split_at;

  IF train_count < 50 THEN
    RAISE EXCEPTION 'Недостаточно данных для обучения: % (нужно >= 50)', train_count;
  END IF;

  DROP TABLE IF EXISTS _norm_stats;
  CREATE TEMP TABLE _norm_stats AS
  SELECT
    AVG(f_velocity) AS m_velocity, COALESCE(NULLIF(STDDEV_POP(f_velocity), 0), 1) AS s_velocity,
    AVG(f_sentiment) AS m_sent, COALESCE(NULLIF(STDDEV_POP(f_sentiment), 0), 1) AS s_sent,
    AVG(f_reach_log) AS m_reach, COALESCE(NULLIF(STDDEV_POP(f_reach_log), 0), 1) AS s_reach,
    AVG(f_kol_count)::NUMERIC AS m_kol, COALESCE(NULLIF(STDDEV_POP(f_kol_count), 0), 1) AS s_kol,
    AVG(f_coord_count)::NUMERIC AS m_coord, COALESCE(NULLIF(STDDEV_POP(f_coord_count), 0), 1) AS s_coord,
    AVG(f_unique_authors)::NUMERIC AS m_auth, COALESCE(NULLIF(STDDEV_POP(f_unique_authors), 0), 1) AS s_auth,
    AVG(f_burst_count)::NUMERIC AS m_burst, COALESCE(NULLIF(STDDEV_POP(f_burst_count), 0), 1) AS s_burst,
    AVG(f_sent_weighted) AS m_sw, COALESCE(NULLIF(STDDEV_POP(f_sent_weighted), 0), 1) AS s_sw,
    AVG(f_lead_ratio) AS m_lead, COALESCE(NULLIF(STDDEV_POP(f_lead_ratio), 0), 1) AS s_lead,
    AVG(f_verified_ratio) AS m_ver, COALESCE(NULLIF(STDDEV_POP(f_verified_ratio), 0), 1) AS s_ver,
    AVG(f_spam_ratio) AS m_spam, COALESCE(NULLIF(STDDEV_POP(f_spam_ratio), 0), 1) AS s_spam
  FROM ml_feature_snapshots
  WHERE horizon_h = p_horizon_h AND label_basis = 'observed_dataset_views' AND label_views_growth_50 IS NOT NULL AND snapshot_at <= split_at;

  SELECT * INTO m_rec FROM _norm_stats;
  feature_means := ARRAY[
    m_rec.m_velocity, m_rec.m_sent, m_rec.m_reach, m_rec.m_kol, m_rec.m_coord,
    m_rec.m_auth, m_rec.m_burst, m_rec.m_sw, m_rec.m_lead, m_rec.m_ver, m_rec.m_spam
  ];
  feature_scales := ARRAY[
    m_rec.s_velocity, m_rec.s_sent, m_rec.s_reach, m_rec.s_kol, m_rec.s_coord,
    m_rec.s_auth, m_rec.s_burst, m_rec.s_sw, m_rec.s_lead, m_rec.s_ver, m_rec.s_spam
  ];

  WHILE epoch < p_epochs LOOP
    FOR sample IN
      SELECT * FROM ml_feature_snapshots
      WHERE horizon_h = p_horizon_h AND label_basis = 'observed_dataset_views' AND label_views_growth_50 IS NOT NULL AND snapshot_at <= split_at
    LOOP
      feats := ARRAY[
        (sample.f_velocity - m_rec.m_velocity) / m_rec.s_velocity,
        (sample.f_sentiment - m_rec.m_sent) / m_rec.s_sent,
        (sample.f_reach_log - m_rec.m_reach) / m_rec.s_reach,
        (sample.f_kol_count - m_rec.m_kol) / m_rec.s_kol,
        (sample.f_coord_count - m_rec.m_coord) / m_rec.s_coord,
        (sample.f_unique_authors - m_rec.m_auth) / m_rec.s_auth,
        (sample.f_burst_count - m_rec.m_burst) / m_rec.s_burst,
        (sample.f_sent_weighted - m_rec.m_sw) / m_rec.s_sw,
        (sample.f_lead_ratio - m_rec.m_lead) / m_rec.s_lead,
        (sample.f_verified_ratio - m_rec.m_ver) / m_rec.s_ver,
        (sample.f_spam_ratio - m_rec.m_spam) / m_rec.s_spam
      ];

      z := intercept;
      FOR i IN 1..n_features LOOP
        z := z + coefs[i] * feats[i];
      END LOOP;
      p := sigmoid(z);

      grad := p - CASE WHEN sample.label_views_growth_50 THEN 1.0 ELSE 0.0 END;
      intercept := intercept - p_lr * grad;
      FOR i IN 1..n_features LOOP
        grad_i := grad * feats[i] + p_l2 * coefs[i];
        coefs[i] := coefs[i] - p_lr * grad_i;
      END LOOP;
    END LOOP;
    epoch := epoch + 1;
  END LOOP;

  SELECT
    AVG(CASE WHEN (sigmoid(intercept + coefs[1]*((f_velocity - m.m_velocity)/m.s_velocity)
                        + coefs[2]*((f_sentiment - m.m_sent)/m.s_sent)
                        + coefs[3]*((f_reach_log - m.m_reach)/m.s_reach)
                        + coefs[4]*((f_kol_count - m.m_kol)/m.s_kol)
                        + coefs[5]*((f_coord_count - m.m_coord)/m.s_coord)
                        + coefs[6]*((f_unique_authors - m.m_auth)/m.s_auth)
                        + coefs[7]*((f_burst_count - m.m_burst)/m.s_burst)
                        + coefs[8]*((f_sent_weighted - m.m_sw)/m.s_sw)
                        + coefs[9]*((f_lead_ratio - m.m_lead)/m.s_lead)
                        + coefs[10]*((f_verified_ratio - m.m_ver)/m.s_ver)
                        + coefs[11]*((f_spam_ratio - m.m_spam)/m.s_spam)) >= 0.5)
              = label_views_growth_50 THEN 1.0 ELSE 0.0 END)::NUMERIC
  INTO train_acc
  FROM ml_feature_snapshots s, _norm_stats m
  WHERE horizon_h = p_horizon_h AND label_basis = 'observed_dataset_views' AND label_views_growth_50 IS NOT NULL AND snapshot_at <= split_at;

  SELECT -AVG(
    CASE WHEN label_views_growth_50 THEN LN(GREATEST(sigmoid(intercept + coefs[1]*((f_velocity - m.m_velocity)/m.s_velocity)
                        + coefs[2]*((f_sentiment - m.m_sent)/m.s_sent)
                        + coefs[3]*((f_reach_log - m.m_reach)/m.s_reach)
                        + coefs[4]*((f_kol_count - m.m_kol)/m.s_kol)
                        + coefs[5]*((f_coord_count - m.m_coord)/m.s_coord)
                        + coefs[6]*((f_unique_authors - m.m_auth)/m.s_auth)
                        + coefs[7]*((f_burst_count - m.m_burst)/m.s_burst)
                        + coefs[8]*((f_sent_weighted - m.m_sw)/m.s_sw)
                        + coefs[9]*((f_lead_ratio - m.m_lead)/m.s_lead)
                        + coefs[10]*((f_verified_ratio - m.m_ver)/m.s_ver)
                        + coefs[11]*((f_spam_ratio - m.m_spam)/m.s_spam)), 0.0001))
         ELSE LN(GREATEST(1 - sigmoid(intercept + coefs[1]*((f_velocity - m.m_velocity)/m.s_velocity)
                        + coefs[2]*((f_sentiment - m.m_sent)/m.s_sent)
                        + coefs[3]*((f_reach_log - m.m_reach)/m.s_reach)
                        + coefs[4]*((f_kol_count - m.m_kol)/m.s_kol)
                        + coefs[5]*((f_coord_count - m.m_coord)/m.s_coord)
                        + coefs[6]*((f_unique_authors - m.m_auth)/m.s_auth)
                        + coefs[7]*((f_burst_count - m.m_burst)/m.s_burst)
                        + coefs[8]*((f_sent_weighted - m.m_sw)/m.s_sw)
                        + coefs[9]*((f_lead_ratio - m.m_lead)/m.s_lead)
                        + coefs[10]*((f_verified_ratio - m.m_ver)/m.s_ver)
                        + coefs[11]*((f_spam_ratio - m.m_spam)/m.s_spam)), 0.0001))
    END)::NUMERIC
  INTO train_ll
  FROM ml_feature_snapshots s, _norm_stats m
  WHERE horizon_h = p_horizon_h AND label_basis = 'observed_dataset_views' AND label_views_growth_50 IS NOT NULL AND snapshot_at <= split_at;

  SELECT
    AVG(CASE WHEN (sigmoid(intercept + coefs[1]*((f_velocity - m.m_velocity)/m.s_velocity)
                        + coefs[2]*((f_sentiment - m.m_sent)/m.s_sent)
                        + coefs[3]*((f_reach_log - m.m_reach)/m.s_reach)
                        + coefs[4]*((f_kol_count - m.m_kol)/m.s_kol)
                        + coefs[5]*((f_coord_count - m.m_coord)/m.s_coord)
                        + coefs[6]*((f_unique_authors - m.m_auth)/m.s_auth)
                        + coefs[7]*((f_burst_count - m.m_burst)/m.s_burst)
                        + coefs[8]*((f_sent_weighted - m.m_sw)/m.s_sw)
                        + coefs[9]*((f_lead_ratio - m.m_lead)/m.s_lead)
                        + coefs[10]*((f_verified_ratio - m.m_ver)/m.s_ver)
                        + coefs[11]*((f_spam_ratio - m.m_spam)/m.s_spam)) >= 0.5)
              = label_views_growth_50 THEN 1.0 ELSE 0.0 END)::NUMERIC
  INTO test_acc
  FROM ml_feature_snapshots s, _norm_stats m
  WHERE horizon_h = p_horizon_h AND label_basis = 'observed_dataset_views' AND label_views_growth_50 IS NOT NULL AND snapshot_at > split_at;

  SELECT -AVG(
    CASE WHEN label_views_growth_50 THEN LN(GREATEST(sigmoid(intercept + coefs[1]*((f_velocity - m.m_velocity)/m.s_velocity)
                        + coefs[2]*((f_sentiment - m.m_sent)/m.s_sent)
                        + coefs[3]*((f_reach_log - m.m_reach)/m.s_reach)
                        + coefs[4]*((f_kol_count - m.m_kol)/m.s_kol)
                        + coefs[5]*((f_coord_count - m.m_coord)/m.s_coord)
                        + coefs[6]*((f_unique_authors - m.m_auth)/m.s_auth)
                        + coefs[7]*((f_burst_count - m.m_burst)/m.s_burst)
                        + coefs[8]*((f_sent_weighted - m.m_sw)/m.s_sw)
                        + coefs[9]*((f_lead_ratio - m.m_lead)/m.s_lead)
                        + coefs[10]*((f_verified_ratio - m.m_ver)/m.s_ver)
                        + coefs[11]*((f_spam_ratio - m.m_spam)/m.s_spam)), 0.0001))
         ELSE LN(GREATEST(1 - sigmoid(intercept + coefs[1]*((f_velocity - m.m_velocity)/m.s_velocity)
                        + coefs[2]*((f_sentiment - m.m_sent)/m.s_sent)
                        + coefs[3]*((f_reach_log - m.m_reach)/m.s_reach)
                        + coefs[4]*((f_kol_count - m.m_kol)/m.s_kol)
                        + coefs[5]*((f_coord_count - m.m_coord)/m.s_coord)
                        + coefs[6]*((f_unique_authors - m.m_auth)/m.s_auth)
                        + coefs[7]*((f_burst_count - m.m_burst)/m.s_burst)
                        + coefs[8]*((f_sent_weighted - m.m_sw)/m.s_sw)
                        + coefs[9]*((f_lead_ratio - m.m_lead)/m.s_lead)
                        + coefs[10]*((f_verified_ratio - m.m_ver)/m.s_ver)
                        + coefs[11]*((f_spam_ratio - m.m_spam)/m.s_spam)), 0.0001))
    END)::NUMERIC
  INTO test_ll
  FROM ml_feature_snapshots s, _norm_stats m
  WHERE horizon_h = p_horizon_h AND label_basis = 'observed_dataset_views' AND label_views_growth_50 IS NOT NULL AND snapshot_at > split_at;

  UPDATE ml_models SET is_active = FALSE WHERE horizon_h = p_horizon_h AND is_active;

  INSERT INTO ml_models (
    name, horizon_h, feature_names, coefficients, feature_means, feature_scales, intercept,
    train_samples, train_accuracy, train_logloss,
    test_samples, test_accuracy, test_logloss,
    trained_at, is_active
  ) VALUES (
    p_name, p_horizon_h, feature_names, coefs, feature_means, feature_scales, intercept,
    train_count, train_acc, train_ll,
    test_count, test_acc, test_ll,
    (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT, TRUE
  )
  RETURNING id INTO model_id;

  DROP TABLE IF EXISTS _norm_stats;
  RETURN model_id;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION predict_mint(p_mint TEXT, p_horizon_h INT DEFAULT 6)
RETURNS TABLE(mint TEXT, probability NUMERIC, prediction BOOLEAN, model_id BIGINT) AS $$
DECLARE
  m RECORD;
  ef RECORD;
  z NUMERIC;
  prob NUMERIC;
BEGIN
  SELECT * INTO m FROM ml_models WHERE horizon_h = p_horizon_h AND is_active ORDER BY trained_at DESC LIMIT 1;
  IF m IS NULL THEN RAISE EXCEPTION 'Нет активной модели для horizon=%', p_horizon_h; END IF;

  SELECT * INTO ef FROM extract_features(p_mint, (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT);
  IF NOT FOUND THEN RAISE EXCEPTION 'No point-in-time feature data for mint=%', p_mint; END IF;

  IF m.feature_means IS NULL OR m.feature_scales IS NULL
     OR array_length(m.feature_means, 1) <> 11 OR array_length(m.feature_scales, 1) <> 11 THEN
    RAISE EXCEPTION 'Active model lacks normalization statistics; retrain the model';
  END IF;

  z := m.intercept
     + m.coefficients[1] * ((COALESCE(ef.f_velocity, 0) - m.feature_means[1]) / m.feature_scales[1])
     + m.coefficients[2] * ((COALESCE(ef.f_sentiment, 0) - m.feature_means[2]) / m.feature_scales[2])
     + m.coefficients[3] * ((COALESCE(ef.f_reach_log, 0) - m.feature_means[3]) / m.feature_scales[3])
     + m.coefficients[4] * ((COALESCE(ef.f_kol_count, 0) - m.feature_means[4]) / m.feature_scales[4])
     + m.coefficients[5] * ((COALESCE(ef.f_coord_count, 0) - m.feature_means[5]) / m.feature_scales[5])
     + m.coefficients[6] * ((COALESCE(ef.f_unique_authors, 0) - m.feature_means[6]) / m.feature_scales[6])
     + m.coefficients[7] * ((COALESCE(ef.f_burst_count, 0) - m.feature_means[7]) / m.feature_scales[7])
     + m.coefficients[8] * ((COALESCE(ef.f_sent_weighted, 0) - m.feature_means[8]) / m.feature_scales[8])
     + m.coefficients[9] * ((COALESCE(ef.f_lead_ratio, 0) - m.feature_means[9]) / m.feature_scales[9])
     + m.coefficients[10] * ((COALESCE(ef.f_verified_ratio, 0) - m.feature_means[10]) / m.feature_scales[10])
     + m.coefficients[11] * ((COALESCE(ef.f_spam_ratio, 0) - m.feature_means[11]) / m.feature_scales[11]);

  prob := sigmoid(z);
  RETURN QUERY SELECT p_mint, ROUND(prob, 4), prob >= 0.5, m.id;
END $$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION backtest_strategy(
  p_strategy TEXT, p_run_name TEXT,
  p_hold_hours INT DEFAULT 6,
  p_from_ms BIGINT DEFAULT NULL, p_to_ms BIGINT DEFAULT NULL,
  p_fee_pct NUMERIC DEFAULT 0
) RETURNS BIGINT AS $$
DECLARE
  run_id BIGINT;
  strat RECORD;
  from_ts BIGINT := COALESCE(p_from_ms, (EXTRACT(EPOCH FROM NOW()) * 1000 - 30 * 86400000)::BIGINT);
  to_ts BIGINT := COALESCE(p_to_ms, (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT);
BEGIN
  IF p_hold_hours < 1 OR p_hold_hours > 720 OR from_ts >= to_ts THEN
    RAISE EXCEPTION 'Invalid backtest time range or hold_hours';
  END IF;
  IF COALESCE(p_fee_pct, 0) <> 0 THEN
    RAISE EXCEPTION 'Fees cannot be applied to an observed-views proxy; use market price data for a financial backtest';
  END IF;

  SELECT * INTO strat FROM strategies WHERE name = p_strategy;
  IF strat IS NULL THEN RAISE EXCEPTION 'Стратегия не найдена: %', p_strategy; END IF;

  INSERT INTO backtest_runs (name, params, started_at, metric_basis, notes)
  VALUES (
    p_run_name,
    jsonb_build_object(
      'strategy', p_strategy, 'hold_hours', p_hold_hours,
      'metric_basis', 'observed_dataset_views_change_pct', 'fee_pct_applied', 0
    ),
    (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
    'observed_dataset_views_change_pct',
    'Observed aggregate views for collected tweets only; not full-platform activity, token price, investment return, or trading P&L.'
  )
  RETURNING id INTO run_id;

  EXECUTE format($sql$
    INSERT INTO backtest_trades (
      run_id, mint, signal_at, entry_score, entry_views, exit_views,
      views_change_pct, return_pct, hold_hours, metadata
    )
    WITH signals AS (%s),
    filtered AS (
      SELECT DISTINCT ON (mint) mint, signal_at, score
      FROM signals
      WHERE signal_at IS NOT NULL
        AND signal_at >= %L
        AND signal_at <= %L - ((%s + 1) * 3600000)
      ORDER BY mint, signal_at
    )
    SELECT %L, f.mint, f.signal_at, f.score,
      e.views, x.views,
      ROUND(((x.views - e.views)::NUMERIC / NULLIF(e.views, 0)) * 100, 4),
      NULL, %s,
      jsonb_build_object('strategy', %L, 'metric_basis', 'observed_dataset_views_change_pct',
                         'entry_observed_at', e.observed_at, 'exit_observed_at', x.observed_at)
    FROM filtered f
    CROSS JOIN LATERAL (
      SELECT observed_at, views
      FROM mint_attention_snapshots
      WHERE mint = f.mint AND observed_at <= f.signal_at
        AND observed_at >= f.signal_at - 3600000
      ORDER BY observed_at DESC LIMIT 1
    ) e
    CROSS JOIN LATERAL (
      SELECT observed_at, views
      FROM mint_attention_snapshots
      WHERE mint = f.mint
        AND observed_at >= f.signal_at + (%s * 3600000)
        AND observed_at < f.signal_at + ((%s + 1) * 3600000)
      ORDER BY observed_at ASC LIMIT 1
    ) x
    WHERE e.views >= 100
  $sql$, strat.rule_sql, from_ts, to_ts, p_hold_hours, run_id,
       p_hold_hours, p_strategy, p_hold_hours, p_hold_hours);

  UPDATE backtest_runs SET
    finished_at = (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
    signals_count = (SELECT COUNT(*) FROM backtest_trades WHERE backtest_trades.run_id = backtest_strategy.run_id),
    avg_views_change_pct = (
      SELECT ROUND(AVG(views_change_pct), 4) FROM backtest_trades
      WHERE backtest_trades.run_id = backtest_strategy.run_id AND views_change_pct IS NOT NULL
    ),
    median_views_change_pct = (
      SELECT ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY views_change_pct)::NUMERIC, 4)
      FROM backtest_trades WHERE backtest_trades.run_id = backtest_strategy.run_id AND views_change_pct IS NOT NULL
    ),
    positive_attention_rate = (
      SELECT ROUND(AVG(CASE WHEN views_change_pct > 0 THEN 1.0 ELSE 0.0 END), 4)
      FROM backtest_trades WHERE backtest_trades.run_id = backtest_strategy.run_id AND views_change_pct IS NOT NULL
    ),
    min_views_change_pct = (
      SELECT ROUND(MIN(views_change_pct), 4) FROM backtest_trades
      WHERE backtest_trades.run_id = backtest_strategy.run_id AND views_change_pct IS NOT NULL
    )
  WHERE id = run_id;

  RETURN run_id;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION backtest_hype_threshold(
  p_run_name TEXT, p_threshold NUMERIC DEFAULT 60,
  p_hold_hours INT DEFAULT 6, p_from_ms BIGINT DEFAULT NULL
) RETURNS BIGINT AS $$
DECLARE
  strategy_name TEXT;
BEGIN
  IF p_threshold < 0 OR p_threshold > 100 THEN
    RAISE EXCEPTION 'Threshold must be between 0 and 100';
  END IF;
  strategy_name := 'hype_threshold_' || replace(p_threshold::TEXT, '.', '_');
  INSERT INTO strategies (name, description, rule_sql, created_at)
  VALUES (
    strategy_name,
    'Historical captured social signal; not a price-based trading strategy',
    'SELECT mint, signal_at, score FROM signal_history WHERE source = ''hype'' AND score >= ' || p_threshold::TEXT,
    (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
  )
  ON CONFLICT (name) DO UPDATE SET rule_sql = EXCLUDED.rule_sql;
  RETURN backtest_strategy(strategy_name, p_run_name, p_hold_hours, p_from_ms, NULL, 0);
END $$ LANGUAGE plpgsql;
