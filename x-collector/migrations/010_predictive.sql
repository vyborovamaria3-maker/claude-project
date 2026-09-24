-- ЗАВИСИТ ОТ: 001..009

CREATE TABLE IF NOT EXISTS ml_feature_snapshots (
  id BIGSERIAL PRIMARY KEY,
  mint TEXT NOT NULL,
  snapshot_at BIGINT NOT NULL,
  horizon_h INTEGER NOT NULL,
  f_velocity NUMERIC(10,4), f_sentiment NUMERIC(6,4),
  f_reach_log NUMERIC(10,4), f_kol_count INTEGER,
  f_coord_count INTEGER, f_unique_authors INTEGER,
  f_burst_count INTEGER, f_sent_weighted NUMERIC(6,4),
  f_lead_ratio NUMERIC(6,4), f_verified_ratio NUMERIC(6,4),
  f_spam_ratio NUMERIC(6,4),
  label_return NUMERIC(12,4), label_win BOOLEAN,
  label_views_change_pct NUMERIC(12,4), label_views_growth_50 BOOLEAN,
  label_basis TEXT NOT NULL DEFAULT 'legacy_unknown',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mlfeat_mint ON ml_feature_snapshots(mint, snapshot_at DESC);
CREATE INDEX IF NOT EXISTS idx_mlfeat_label ON ml_feature_snapshots(label_basis, horizon_h, label_views_growth_50);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mlfeat_snapshot_unique ON ml_feature_snapshots(mint, snapshot_at, horizon_h);

CREATE TABLE IF NOT EXISTS ml_models (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL, horizon_h INTEGER NOT NULL,
  target_name TEXT NOT NULL DEFAULT 'observed_dataset_views_growth_50_pct',
  feature_names TEXT[] NOT NULL,
  coefficients NUMERIC(12,8)[] NOT NULL,
  feature_means NUMERIC(12,8)[],
  feature_scales NUMERIC(12,8)[],
  intercept NUMERIC(12,8) NOT NULL,
  train_samples INTEGER NOT NULL,
  train_accuracy NUMERIC(6,4), train_logloss NUMERIC(10,6),
  test_samples INTEGER NOT NULL DEFAULT 0,
  test_accuracy NUMERIC(6,4), test_logloss NUMERIC(10,6),
  trained_at BIGINT NOT NULL, is_active BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_ml_models_active ON ml_models(horizon_h, is_active);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ml_models_one_active ON ml_models(horizon_h) WHERE is_active;

CREATE OR REPLACE FUNCTION sigmoid(x NUMERIC) RETURNS NUMERIC AS $$
BEGIN
  IF x > 500 THEN RETURN 1.0; END IF;
  IF x < -500 THEN RETURN 0.0; END IF;
  RETURN 1.0 / (1.0 + EXP(-x));
END $$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION extract_features(p_mint TEXT, p_at BIGINT)
RETURNS TABLE(
  f_velocity NUMERIC, f_sentiment NUMERIC, f_reach_log NUMERIC,
  f_kol_count INTEGER, f_coord_count INTEGER, f_unique_authors INTEGER,
  f_burst_count INTEGER, f_sent_weighted NUMERIC, f_lead_ratio NUMERIC,
  f_verified_ratio NUMERIC, f_spam_ratio NUMERIC
) AS $$
DECLARE
  window_1h_ms BIGINT := 3600000;
  window_24h_ms BIGINT := 86400000;
BEGIN
  RETURN QUERY
  WITH tweets_window AS (
    SELECT t.tweet_id, t.handle, t.views, t.likes, t.retweets, t.is_verified, t.text, t.posted_at
    FROM tweet_token_links l
    JOIN twitter_tweets t ON t.tweet_id = l.tweet_id
    WHERE l.mint = p_mint AND t.posted_at <= p_at AND t.posted_at > p_at - window_24h_ms
  ),
  hourly AS (
    SELECT
      COALESCE(SUM(CASE WHEN posted_at > p_at - window_1h_ms THEN 1 ELSE 0 END), 0) AS last_h,
      COALESCE(SUM(CASE WHEN posted_at <= p_at - window_1h_ms THEN 1 ELSE 0 END), 0)::NUMERIC / 23.0 AS avg_h
    FROM tweets_window
  )
  SELECT
    CASE WHEN h.avg_h > 0 THEN LEAST(h.last_h::NUMERIC / h.avg_h, 10) ELSE h.last_h::NUMERIC END,
    COALESCE((SELECT AVG(s.score) FROM tweet_sentiment s
              JOIN tweets_window tw ON tw.tweet_id = s.tweet_id), 0),
    COALESCE(LOG(GREATEST(SUM(t.views), 1)), 0),
    COALESCE(COUNT(DISTINCT CASE WHEN t.is_verified THEN t.handle END), 0)::INT,
    COALESCE((
      SELECT COUNT(*) FROM (
        SELECT md5(regexp_replace(lower(tw2.text), '\s+', ' ', 'g')) AS h
        FROM tweets_window tw2 WHERE length(tw2.text) > 30 GROUP BY h HAVING COUNT(*) >= 3
      ) c
    ), 0)::INT,
    COUNT(DISTINCT t.handle)::INT,
    COALESCE((
      SELECT COUNT(*) FROM (
        SELECT (tw3.posted_at / 3600000)::BIGINT AS h
        FROM tweets_window tw3 GROUP BY h HAVING COUNT(*) >= 10
      ) b
    ), 0)::INT,
    COALESCE((
      SELECT SUM(s.score * COALESCE(r.reputation_score, 50) / 50.0)
           / NULLIF(SUM(COALESCE(r.reputation_score, 50) / 50.0), 0)
      FROM tweet_sentiment s
      JOIN tweets_window tw4 ON tw4.tweet_id = s.tweet_id
      LEFT JOIN author_reputation r ON r.handle = tw4.handle
    ), 0),
    COALESCE((
      SELECT AVG(CASE WHEN ls.lead_ratio >= 0.3 THEN 1.0 ELSE 0.0 END)
      FROM tweets_window tw5
      LEFT JOIN author_lead_stats ls ON ls.handle = tw5.handle
    ), 0),
    CASE WHEN COUNT(*) > 0
         THEN COUNT(DISTINCT CASE WHEN t.is_verified THEN t.handle END)::NUMERIC / COUNT(DISTINCT t.handle)
         ELSE 0 END,
    COALESCE((
      SELECT AVG(tx.spam_score) FROM tweet_toxicity tx
      JOIN tweets_window tw6 ON tw6.tweet_id = tx.tweet_id
    ), 0)
  FROM tweets_window t
  CROSS JOIN hourly h
  GROUP BY h.last_h, h.avg_h;
END $$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION build_training_data(p_horizon_h INT DEFAULT 6, p_step_h INT DEFAULT 12)
RETURNS INTEGER AS $$
DECLARE
  cnt INTEGER := 0;
  rec RECORD;
  feat RECORD;
  views_change_pct NUMERIC;
  views_now BIGINT;
  views_then BIGINT;
BEGIN
  FOR rec IN SELECT DISTINCT l.mint FROM tweet_token_links l
  LOOP
    FOR feat IN
      SELECT generate_series(
        (SELECT MIN(t.posted_at) FROM tweet_token_links l JOIN twitter_tweets t ON t.tweet_id=l.tweet_id WHERE l.mint = rec.mint),
        (SELECT MAX(t.posted_at) FROM tweet_token_links l JOIN twitter_tweets t ON t.tweet_id=l.tweet_id WHERE l.mint = rec.mint) - (p_horizon_h * 3600000),
        (p_step_h * 3600000)
      )::BIGINT AS snap_at
    LOOP
      CONTINUE WHEN EXISTS (
        SELECT 1 FROM ml_feature_snapshots 
        WHERE mint = rec.mint AND snapshot_at = feat.snap_at AND horizon_h = p_horizon_h
      );

      SELECT COALESCE(SUM(t.views), 0) INTO views_now
      FROM tweet_token_links l JOIN twitter_tweets t ON t.tweet_id=l.tweet_id
      WHERE l.mint = rec.mint AND t.posted_at <= feat.snap_at AND t.posted_at > feat.snap_at - 3600000;

      CONTINUE WHEN views_now < 100;

      SELECT COALESCE(SUM(t.views), 0) INTO views_then
      FROM tweet_token_links l JOIN twitter_tweets t ON t.tweet_id=l.tweet_id
      WHERE l.mint = rec.mint 
        AND t.posted_at > feat.snap_at + (p_horizon_h * 3600000) - 3600000
        AND t.posted_at <= feat.snap_at + (p_horizon_h * 3600000);

      views_change_pct := CASE WHEN views_now > 0
                               THEN ROUND((views_then - views_now)::NUMERIC / views_now * 100, 4)
                               ELSE 0 END;

      INSERT INTO ml_feature_snapshots (
        mint, snapshot_at, horizon_h,
        f_velocity, f_sentiment, f_reach_log, f_kol_count, f_coord_count,
        f_unique_authors, f_burst_count, f_sent_weighted, f_lead_ratio,
        f_verified_ratio, f_spam_ratio, label_views_change_pct, label_views_growth_50,
        created_at
      )
      SELECT
        rec.mint, feat.snap_at, p_horizon_h,
        ef.f_velocity, ef.f_sentiment, ef.f_reach_log, ef.f_kol_count, ef.f_coord_count,
        ef.f_unique_authors, ef.f_burst_count, ef.f_sent_weighted, ef.f_lead_ratio,
        ef.f_verified_ratio, ef.f_spam_ratio,
        views_change_pct, views_change_pct >= 50,
        (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
      FROM extract_features(rec.mint, feat.snap_at) ef
      ON CONFLICT (mint, snapshot_at, horizon_h) DO NOTHING;

      cnt := cnt + 1;
    END LOOP;
  END LOOP;
  RETURN cnt;
END $$ LANGUAGE plpgsql;

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

DROP VIEW IF EXISTS v_cross_mint_signals CASCADE;
CREATE VIEW v_cross_mint_signals AS
WITH kol_mentions AS (
  SELECT t.handle, l.mint, MIN(t.posted_at) AS first_mention_at, r.reputation_score
  FROM tweet_token_links l
  JOIN twitter_tweets t ON t.tweet_id = l.tweet_id
  LEFT JOIN author_reputation r ON r.handle = t.handle
  WHERE COALESCE(r.reputation_score, 0) >= 60 OR t.is_verified
  GROUP BY t.handle, l.mint, r.reputation_score
),
transitions AS (
  SELECT a.handle, a.mint AS mint_from, b.mint AS mint_to,
    a.first_mention_at AS at_from, b.first_mention_at AS at_to,
    b.first_mention_at - a.first_mention_at AS lag_ms
  FROM kol_mentions a
  JOIN kol_mentions b ON b.handle = a.handle AND b.mint != a.mint
  WHERE b.first_mention_at > a.first_mention_at
    AND b.first_mention_at - a.first_mention_at <= 86400000
),
propagation AS (
  SELECT mint_from, mint_to,
    COUNT(DISTINCT handle)::INT AS via_kols,
    ROUND(AVG(lag_ms) / 3600000, 2) AS avg_lag_hours,
    MIN(lag_ms) / 3600000 AS min_lag_hours
  FROM transitions
  GROUP BY mint_from, mint_to
)
SELECT p.mint_from, p.mint_to, p.via_kols, p.avg_lag_hours, p.min_lag_hours,
  COALESCE((
    SELECT SUM(tweets) FROM mint_metrics_1h
    WHERE mint = p.mint_to AND bucket >= (EXTRACT(EPOCH FROM NOW()) * 1000 - 7200000)::BIGINT
  ), 0) AS recent_to_tweets,
  COALESCE((
    SELECT COUNT(DISTINCT handle) FROM kol_mentions
    WHERE mint = p.mint_from
      AND first_mention_at >= (EXTRACT(EPOCH FROM NOW()) * 1000 - 6 * 3600000)::BIGINT
  ), 0) AS recent_from_kols
FROM propagation p
WHERE p.via_kols >= 2
ORDER BY p.via_kols DESC, p.avg_lag_hours ASC;

CREATE OR REPLACE FUNCTION decay_weight(p_age_ms BIGINT, p_halflife_h NUMERIC DEFAULT 6)
RETURNS NUMERIC AS $$
BEGIN
  RETURN EXP(-(p_age_ms / 3600000.0) / NULLIF(p_halflife_h, 0));
END $$ LANGUAGE plpgsql IMMUTABLE;

DROP VIEW IF EXISTS v_mint_decay_scores CASCADE;
CREATE VIEW v_mint_decay_scores AS
SELECT l.mint, COUNT(*)::INT AS raw_tweets,
  ROUND(SUM(decay_weight((EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT - t.posted_at, 6)), 4) AS decayed_tweets_6h,
  ROUND(SUM(decay_weight((EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT - t.posted_at, 24)), 4) AS decayed_tweets_24h,
  ROUND(SUM(t.views * decay_weight((EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT - t.posted_at, 6)), 2) AS decayed_views,
  to_char(to_timestamp(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY t.posted_at) / 1000), 'YYYY-MM-DD HH24:MI') AS median_time
FROM tweet_token_links l
JOIN twitter_tweets t ON t.tweet_id = l.tweet_id
WHERE t.posted_at IS NOT NULL
GROUP BY l.mint;

DROP VIEW IF EXISTS v_mint_freshness CASCADE;
CREATE VIEW v_mint_freshness AS
SELECT l.mint,
  MAX(t.posted_at) AS last_tweet_at,
  MIN(t.posted_at) AS first_tweet_at,
  EXTRACT(EPOCH FROM NOW()) * 1000 - MAX(t.posted_at) AS age_since_last_ms,
  MAX(t.posted_at) - MIN(t.posted_at) AS lifespan_ms,
  CASE
    WHEN MAX(t.posted_at) > (EXTRACT(EPOCH FROM NOW()) * 1000 - 3600000)::BIGINT THEN 1.0
    WHEN MAX(t.posted_at) > (EXTRACT(EPOCH FROM NOW()) * 1000 - 6 * 3600000)::BIGINT THEN 0.8
    WHEN MAX(t.posted_at) > (EXTRACT(EPOCH FROM NOW()) * 1000 - 24 * 3600000)::BIGINT THEN 0.5
    WHEN MAX(t.posted_at) > (EXTRACT(EPOCH FROM NOW()) * 1000 - 7 * 86400000)::BIGINT THEN 0.2
    ELSE 0.0
  END AS freshness_score
FROM tweet_token_links l
JOIN twitter_tweets t ON t.tweet_id = l.tweet_id
WHERE t.posted_at IS NOT NULL
GROUP BY l.mint;

DROP VIEW IF EXISTS v_sentiment_divergence CASCADE;
CREATE VIEW v_sentiment_divergence AS
WITH per_author AS (
  SELECT l.mint, l.handle,
    AVG(s.score) AS avg_sent, COUNT(*) AS tweets,
    COALESCE(r.reputation_score, 50) AS rep,
    COALESCE(t.is_verified, FALSE) AS is_ver,
    COALESCE(p.followers, 100) AS followers
  FROM tweet_token_links l
  JOIN tweet_sentiment s ON s.tweet_id = l.tweet_id
  LEFT JOIN author_reputation r ON r.handle = l.handle
  LEFT JOIN twitter_tweets t ON t.tweet_id = l.tweet_id
  LEFT JOIN twitter_profiles p ON p.handle = l.handle
  GROUP BY l.mint, l.handle, r.reputation_score, t.is_verified, p.followers
)
SELECT mint, COUNT(DISTINCT handle)::INT AS authors,
  ROUND(AVG(avg_sent) FILTER (WHERE rep >= 60 OR is_ver), 4) AS kol_sentiment,
  ROUND(AVG(avg_sent) FILTER (WHERE rep < 60 AND NOT is_ver), 4) AS crowd_sentiment,
  ROUND(AVG(avg_sent) FILTER (WHERE followers >= 10000), 4) AS big_sentiment,
  ROUND(AVG(avg_sent) FILTER (WHERE followers < 1000), 4) AS small_sentiment,
  ROUND(
    COALESCE(AVG(avg_sent) FILTER (WHERE rep >= 60 OR is_ver), 0)
    - COALESCE(AVG(avg_sent) FILTER (WHERE rep < 60 AND NOT is_ver), 0), 4
  ) AS divergence
FROM per_author
GROUP BY mint
HAVING COUNT(DISTINCT handle) >= 5;

CREATE OR REPLACE FUNCTION compute_ultra_score(p_mint TEXT)
RETURNS TABLE(
  mint TEXT, ultra_score NUMERIC, hype NUMERIC, freshness NUMERIC,
  decay NUMERIC, divergence NUMERIC, lead NUMERIC, ml_prob NUMERIC, components JSONB
) AS $$
DECLARE
  v_hype NUMERIC := 0; v_fresh NUMERIC := 0; v_decay NUMERIC := 0;
  v_div NUMERIC := 0; v_lead NUMERIC := 0; v_ml NUMERIC := 0; v_final NUMERIC := 0;
BEGIN
  SELECT COALESCE(hype_score, 0) INTO v_hype FROM mint_hype_scores WHERE mint = p_mint;
  SELECT COALESCE(freshness_score, 0) INTO v_fresh FROM v_mint_freshness WHERE mint = p_mint;

  SELECT CASE WHEN raw_tweets > 0 THEN COALESCE(decayed_tweets_6h / raw_tweets, 0) ELSE 0 END
  INTO v_decay FROM v_mint_decay_scores WHERE mint = p_mint;

  SELECT CASE 
    WHEN divergence IS NULL THEN 0
    WHEN divergence > 0.5 THEN 1.0
    WHEN divergence > 0.2 THEN 0.7
    WHEN divergence > 0 THEN 0.4
    ELSE 0
  END INTO v_div FROM v_sentiment_divergence WHERE mint = p_mint;

  SELECT LEAST(COUNT(DISTINCT t.handle)::NUMERIC / 10, 1.0) INTO v_lead
  FROM tweet_token_links l
  JOIN twitter_tweets t ON t.tweet_id = l.tweet_id
  JOIN author_lead_stats ls ON ls.handle = t.handle
  WHERE l.mint = p_mint AND ls.lead_ratio >= 0.3;

  BEGIN
    SELECT probability INTO v_ml FROM predict_mint(p_mint, 6);
  EXCEPTION WHEN OTHERS THEN
    v_ml := 0;
  END;

  v_final := 100 * (
    0.25 * LEAST(v_hype / 100, 1) + 0.10 * v_fresh + 0.10 * v_decay
    + 0.15 * v_div + 0.15 * v_lead + 0.25 * v_ml
  );

  RETURN QUERY SELECT p_mint,
    ROUND(v_final, 2), ROUND(v_hype, 2), ROUND(v_fresh, 4),
    ROUND(v_decay, 4), ROUND(v_div, 4), ROUND(v_lead, 4), ROUND(v_ml, 4),
    jsonb_build_object('hype', v_hype, 'freshness', v_fresh, 'decay', v_decay,
                       'divergence', v_div, 'lead', v_lead, 'ml', v_ml);
END $$ LANGUAGE plpgsql STABLE;

CREATE TABLE IF NOT EXISTS mint_ultra_scores (
  mint TEXT PRIMARY KEY,
  ultra_score NUMERIC(5,2) NOT NULL,
  hype NUMERIC(6,2), freshness NUMERIC(6,4),
  decay NUMERIC(6,4), divergence NUMERIC(6,4),
  lead NUMERIC(6,4), ml_prob NUMERIC(6,4),
  components JSONB, computed_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ultra ON mint_ultra_scores(ultra_score DESC);

CREATE OR REPLACE FUNCTION rebuild_ultra_scores() RETURNS INTEGER AS $$
DECLARE cnt INTEGER := 0;
BEGIN
  INSERT INTO mint_ultra_scores (mint, ultra_score, hype, freshness, decay, divergence, lead, ml_prob, components, computed_at)
  SELECT u.mint, u.ultra_score, u.hype, u.freshness, u.decay, u.divergence, u.lead, u.ml_prob, u.components,
    (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
  FROM (
    SELECT DISTINCT l.mint FROM tweet_token_links l
    JOIN twitter_tweets t ON t.tweet_id = l.tweet_id
    WHERE t.posted_at >= (EXTRACT(EPOCH FROM NOW()) * 1000 - 7 * 86400000)::BIGINT
  ) m
  CROSS JOIN LATERAL compute_ultra_score(m.mint) u
  ON CONFLICT (mint) DO UPDATE SET
    ultra_score = EXCLUDED.ultra_score, hype = EXCLUDED.hype,
    freshness = EXCLUDED.freshness, decay = EXCLUDED.decay,
    divergence = EXCLUDED.divergence, lead = EXCLUDED.lead,
    ml_prob = EXCLUDED.ml_prob, components = EXCLUDED.components,
    computed_at = EXCLUDED.computed_at;

  GET DIAGNOSTICS cnt = ROW_COUNT;
  RETURN cnt;
END $$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS strategies (
  name TEXT PRIMARY KEY,
  description TEXT,
  rule_sql TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

INSERT INTO strategies (name, description, rule_sql, created_at) VALUES
  ('hype_gt_60', 'Вход при hype_score >= 60',
   'SELECT mint, signal_at, score FROM signal_history WHERE source = ''hype'' AND score >= 60',
   (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT),
  ('ultra_gt_70', 'Вход при ultra_score >= 70',
   'SELECT mint, signal_at, score FROM signal_history WHERE source = ''ultra'' AND score >= 70',
   (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT),
  ('early_signal', 'Early signals strength >= 60',
   'SELECT mint, signal_at, score FROM signal_history WHERE source = ''early_signal'' AND score >= 60',
   (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT)
ON CONFLICT (name) DO NOTHING;

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
