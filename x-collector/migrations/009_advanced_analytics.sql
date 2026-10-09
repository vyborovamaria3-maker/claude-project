-- ЗАВИСИТ ОТ: 001..008

CREATE OR REPLACE FUNCTION compute_hype_score(p_mint TEXT)
RETURNS TABLE (
  mint TEXT, hype_score NUMERIC, velocity NUMERIC, sentiment NUMERIC,
  reach NUMERIC, kol_density NUMERIC, coord_penalty NUMERIC, computed_at BIGINT
) AS $$
DECLARE
  v_1h BIGINT;
  v_24h BIGINT;
  v_avg_24h NUMERIC;
  v_sent NUMERIC;
  v_reach NUMERIC;
  v_kol NUMERIC;
  v_coord NUMERIC;
  v_velocity NUMERIC;
  v_reach_norm NUMERIC;
  v_kol_norm NUMERIC;
  v_final NUMERIC;
BEGIN
  SELECT COALESCE(SUM(tweets), 0) INTO v_1h
  FROM mint_metrics_1h
  WHERE mint = p_mint AND bucket >= (EXTRACT(EPOCH FROM NOW()) * 1000 - 3600000)::BIGINT;

  SELECT COALESCE(SUM(tweets), 0) INTO v_24h
  FROM mint_metrics_1h
  WHERE mint = p_mint AND bucket >= (EXTRACT(EPOCH FROM NOW()) * 1000 - 86400000)::BIGINT;

  v_avg_24h := v_24h::NUMERIC / 24.0;

  v_velocity := CASE
    WHEN v_avg_24h > 0 THEN LEAST(v_1h::NUMERIC / v_avg_24h, 10)
    WHEN v_1h > 0 THEN 5
    ELSE 0
  END;

  SELECT COALESCE(AVG(score), 0) INTO v_sent
  FROM tweet_sentiment s
  JOIN tweet_token_links l ON l.tweet_id = s.tweet_id
  WHERE l.mint = p_mint;

  SELECT COALESCE(SUM(views), 0) INTO v_reach
  FROM mint_metrics_1h
  WHERE mint = p_mint AND bucket >= (EXTRACT(EPOCH FROM NOW()) * 1000 - 86400000)::BIGINT;

  SELECT COALESCE(COUNT(DISTINCT t.handle), 0) INTO v_kol
  FROM tweet_token_links l
  JOIN twitter_tweets t ON t.tweet_id = l.tweet_id
  LEFT JOIN author_reputation r ON r.handle = t.handle
  WHERE l.mint = p_mint
    AND (t.is_verified OR COALESCE(r.reputation_score, 0) >= 60)
    AND t.posted_at >= (EXTRACT(EPOCH FROM NOW()) * 1000 - 86400000)::BIGINT;

  SELECT COALESCE(COUNT(*), 0) INTO v_coord
  FROM (
    SELECT 1 FROM tweet_token_links l
    JOIN twitter_tweets t ON t.tweet_id = l.tweet_id
    WHERE l.mint = p_mint AND length(t.text) > 30
    GROUP BY md5(regexp_replace(lower(t.text), '\s+', ' ', 'g'))
    HAVING COUNT(DISTINCT t.handle) >= 3
  ) x;

  v_velocity := LEAST(v_velocity / 3.0, 1.0);
  v_sent := (v_sent + 1) / 2;
  v_reach_norm := LEAST(LOG(GREATEST(v_reach, 1)) / 15.0, 1.0);
  v_kol_norm := LEAST(v_kol / 10.0, 1.0);
  v_coord := LEAST(v_coord / 5.0, 1.0);

  v_final := 100 * (
    0.25 * v_velocity + 0.15 * v_sent + 0.20 * v_reach_norm
    + 0.20 * v_kol_norm - 0.20 * v_coord
  );
  v_final := GREATEST(0, LEAST(100, v_final));

  RETURN QUERY SELECT p_mint,
    ROUND(v_final, 2), ROUND(v_velocity, 4), ROUND(v_sent, 4),
    ROUND(v_reach_norm, 4), ROUND(v_kol_norm, 4), ROUND(v_coord, 4),
    (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT;
END $$ LANGUAGE plpgsql STABLE;

CREATE TABLE IF NOT EXISTS mint_hype_scores (
  mint TEXT PRIMARY KEY,
  hype_score NUMERIC(5,2) NOT NULL,
  velocity NUMERIC(5,4), sentiment NUMERIC(5,4),
  reach NUMERIC(5,4), kol_density NUMERIC(5,4), coord_penalty NUMERIC(5,4),
  prev_score NUMERIC(5,2), delta_1h NUMERIC(5,2),
  computed_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hype_score ON mint_hype_scores(hype_score DESC);
CREATE INDEX IF NOT EXISTS idx_hype_delta ON mint_hype_scores(delta_1h DESC NULLS LAST);

CREATE OR REPLACE FUNCTION rebuild_hype_scores() RETURNS INTEGER AS $$
DECLARE cnt INTEGER := 0;
BEGIN
  INSERT INTO mint_hype_scores (
    mint, hype_score, velocity, sentiment, reach, kol_density, coord_penalty,
    prev_score, delta_1h, computed_at
  )
  SELECT m.mint, h.hype_score, h.velocity, h.sentiment, h.reach, h.kol_density, h.coord_penalty,
    (SELECT hype_score FROM mint_hype_scores WHERE mint = m.mint),
    h.hype_score - COALESCE((SELECT hype_score FROM mint_hype_scores WHERE mint = m.mint), h.hype_score),
    (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
  FROM (
    SELECT DISTINCT mint FROM mint_metrics_1h
    WHERE bucket >= (EXTRACT(EPOCH FROM NOW()) * 1000 - 86400000)::BIGINT
  ) m
  CROSS JOIN LATERAL compute_hype_score(m.mint) h
  ON CONFLICT (mint) DO UPDATE SET
    hype_score = EXCLUDED.hype_score,
    velocity = EXCLUDED.velocity,
    sentiment = EXCLUDED.sentiment,
    reach = EXCLUDED.reach,
    kol_density = EXCLUDED.kol_density,
    coord_penalty = EXCLUDED.coord_penalty,
    prev_score = mint_hype_scores.hype_score,
    delta_1h = EXCLUDED.hype_score - mint_hype_scores.hype_score,
    computed_at = EXCLUDED.computed_at;

  GET DIAGNOSTICS cnt = ROW_COUNT;
  RETURN cnt;
END $$ LANGUAGE plpgsql;

DROP VIEW IF EXISTS v_early_signals CASCADE;
CREATE VIEW v_early_signals AS
WITH recent AS (
  SELECT mint,
    SUM(tweets) FILTER (WHERE bucket >= (EXTRACT(EPOCH FROM NOW()) * 1000 - 1800000)::BIGINT) AS last_30m,
    SUM(tweets) FILTER (WHERE bucket >= (EXTRACT(EPOCH FROM NOW()) * 1000 - 7200000)::BIGINT
                          AND bucket < (EXTRACT(EPOCH FROM NOW()) * 1000 - 1800000)::BIGINT) AS prev_90m,
    COUNT(DISTINCT authors) AS recent_authors
  FROM mint_metrics_1h
  WHERE bucket >= (EXTRACT(EPOCH FROM NOW()) * 1000 - 86400000)::BIGINT
  GROUP BY mint
),
sentiment_shift AS (
  SELECT l.mint,
    AVG(s.score) FILTER (WHERE t.posted_at >= (EXTRACT(EPOCH FROM NOW()) * 1000 - 1800000)::BIGINT) AS sent_recent,
    AVG(s.score) FILTER (WHERE t.posted_at < (EXTRACT(EPOCH FROM NOW()) * 1000 - 1800000)::BIGINT
                            AND t.posted_at >= (EXTRACT(EPOCH FROM NOW()) * 1000 - 86400000)::BIGINT) AS sent_baseline
  FROM tweet_sentiment s
  JOIN tweet_token_links l ON l.tweet_id = s.tweet_id
  JOIN twitter_tweets t ON t.tweet_id = l.tweet_id
  GROUP BY l.mint
),
kol_influx AS (
  SELECT l.mint,
    COUNT(DISTINCT t.handle) FILTER (
      WHERE t.posted_at >= (EXTRACT(EPOCH FROM NOW()) * 1000 - 1800000)::BIGINT
        AND (t.is_verified OR COALESCE(r.reputation_score, 50) >= 70)
    ) AS kol_30m
  FROM tweet_token_links l
  JOIN twitter_tweets t ON t.tweet_id = l.tweet_id
  LEFT JOIN author_reputation r ON r.handle = t.handle
  GROUP BY l.mint
)
SELECT r.mint, h.hype_score, h.delta_1h, r.last_30m, r.prev_90m,
  CASE WHEN r.prev_90m > 0 THEN ROUND(r.last_30m::NUMERIC / (r.prev_90m / 3.0), 2) ELSE NULL END AS velocity_x,
  ROUND(s.sent_recent, 4) AS sent_now,
  ROUND(s.sent_baseline, 4) AS sent_base,
  ROUND(COALESCE(s.sent_recent, 0) - COALESCE(s.sent_baseline, 0), 4) AS sent_delta,
  COALESCE(k.kol_30m, 0) AS kol_last_30m,
  (
    CASE WHEN COALESCE(r.prev_90m, 0) = 0 AND r.last_30m >= 5 THEN 30 ELSE 0 END
    + CASE WHEN r.prev_90m > 0 AND r.last_30m::NUMERIC / (r.prev_90m / 3.0) >= 2 THEN 25 ELSE 0 END
    + CASE WHEN COALESCE(s.sent_recent, 0) - COALESCE(s.sent_baseline, 0) >= 0.2 THEN 20 ELSE 0 END
    + CASE WHEN COALESCE(k.kol_30m, 0) >= 2 THEN 25 ELSE 0 END
    + CASE WHEN h.delta_1h >= 15 THEN 20 ELSE 0 END
  ) AS signal_strength
FROM recent r
LEFT JOIN sentiment_shift s ON s.mint = r.mint
LEFT JOIN kol_influx k ON k.mint = r.mint
LEFT JOIN mint_hype_scores h ON h.mint = r.mint
WHERE r.last_30m >= 3
  AND (h.hype_score IS NULL OR h.hype_score < 80)
ORDER BY signal_strength DESC NULLS LAST, h.hype_score DESC NULLS LAST;

CREATE OR REPLACE FUNCTION similar_mints(p_mint TEXT, p_limit INT DEFAULT 20)
RETURNS TABLE (other_mint TEXT, shared_authors INT, jaccard NUMERIC, pattern_corr NUMERIC, final_score NUMERIC) AS $$
BEGIN
  RETURN QUERY
  WITH base_authors AS (
    SELECT DISTINCT handle FROM tweet_token_links WHERE mint = p_mint
  ),
  candidate_authors AS (
    SELECT mint, COUNT(DISTINCT handle) AS shared
    FROM tweet_token_links
    WHERE mint != p_mint AND handle IN (SELECT handle FROM base_authors)
    GROUP BY mint HAVING COUNT(DISTINCT handle) >= 2
  ),
  base_total AS (SELECT COUNT(*)::NUMERIC AS n FROM base_authors),
  other_totals AS (
    SELECT mint, COUNT(DISTINCT handle)::NUMERIC AS n
    FROM tweet_token_links
    WHERE mint IN (SELECT mint FROM candidate_authors)
    GROUP BY mint
  ),
  jaccard_calc AS (
    SELECT c.mint, c.shared, c.shared / (b.n + o.n - c.shared) AS jaccard_score
    FROM candidate_authors c
    JOIN base_total b ON TRUE
    JOIN other_totals o ON o.mint = c.mint
  )
  SELECT j.mint, j.shared, ROUND(j.jaccard_score, 4),
    NULL::NUMERIC,
    ROUND(j.jaccard_score * 100, 2)
  FROM jaccard_calc j
  ORDER BY jaccard_score DESC
  LIMIT p_limit;
END $$ LANGUAGE plpgsql STABLE;

CREATE TABLE IF NOT EXISTS mint_similarity (
  mint_a TEXT NOT NULL, mint_b TEXT NOT NULL,
  shared_authors INT NOT NULL, jaccard NUMERIC(6,4) NOT NULL,
  computed_at BIGINT NOT NULL,
  PRIMARY KEY (mint_a, mint_b)
);
CREATE INDEX IF NOT EXISTS idx_sim_a ON mint_similarity(mint_a, jaccard DESC);

CREATE OR REPLACE FUNCTION rebuild_mint_similarity() RETURNS INTEGER AS $$
DECLARE cnt INTEGER;
BEGIN
  DELETE FROM mint_similarity WHERE computed_at < (EXTRACT(EPOCH FROM NOW()) * 1000 - 86400000)::BIGINT;

  INSERT INTO mint_similarity (mint_a, mint_b, shared_authors, jaccard, computed_at)
  WITH pairs AS (
    SELECT LEAST(a.mint, b.mint) AS mint_a,
           GREATEST(a.mint, b.mint) AS mint_b,
           COUNT(DISTINCT a.handle) AS shared
    FROM tweet_token_links a
    JOIN tweet_token_links b ON a.handle = b.handle AND a.mint < b.mint
    GROUP BY mint_a, mint_b HAVING COUNT(DISTINCT a.handle) >= 3
  ),
  totals AS (
    SELECT mint, COUNT(DISTINCT handle)::NUMERIC AS n
    FROM tweet_token_links
    WHERE mint IN (SELECT mint_a FROM pairs UNION SELECT mint_b FROM pairs)
    GROUP BY mint
  )
  SELECT p.mint_a, p.mint_b, p.shared,
    ROUND(p.shared / (ta.n + tb.n - p.shared), 4),
    (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
  FROM pairs p
  JOIN totals ta ON ta.mint = p.mint_a
  JOIN totals tb ON tb.mint = p.mint_b
  ON CONFLICT (mint_a, mint_b) DO UPDATE SET
    shared_authors = EXCLUDED.shared_authors,
    jaccard = EXCLUDED.jaccard,
    computed_at = EXCLUDED.computed_at;

  GET DIAGNOSTICS cnt = ROW_COUNT;
  RETURN cnt;
END $$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS author_lead_stats (
  handle TEXT PRIMARY KEY,
  mint_starts INTEGER NOT NULL DEFAULT 0,
  mint_participated INTEGER NOT NULL DEFAULT 0,
  avg_lead_minutes NUMERIC(10,2),
  median_lead_minutes NUMERIC(10,2),
  lead_ratio NUMERIC(5,4),
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lead_ratio ON author_lead_stats(lead_ratio DESC);

CREATE OR REPLACE FUNCTION rebuild_author_lead_stats() RETURNS INTEGER AS $$
DECLARE cnt INTEGER;
BEGIN
  INSERT INTO author_lead_stats (handle, mint_starts, mint_participated, avg_lead_minutes, median_lead_minutes, lead_ratio, updated_at)
  WITH firsts AS (
    SELECT l.mint, MIN(t.posted_at) AS first_at,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY t.posted_at) AS median_at
    FROM tweet_token_links l
    JOIN twitter_tweets t ON t.tweet_id = l.tweet_id
    WHERE t.posted_at IS NOT NULL
    GROUP BY l.mint
  ),
  author_stats AS (
    SELECT t.handle, l.mint,
      MIN(t.posted_at) AS author_first_at,
      f.first_at, f.median_at,
      (MIN(t.posted_at) - f.first_at) / 60000.0 AS lead_minutes_from_first,
      (f.median_at - MIN(t.posted_at)) / 60000.0 AS lead_minutes_from_median
    FROM tweet_token_links l
    JOIN twitter_tweets t ON t.tweet_id = l.tweet_id
    JOIN firsts f ON f.mint = l.mint
    WHERE t.posted_at IS NOT NULL
    GROUP BY t.handle, l.mint, f.first_at, f.median_at
  )
  SELECT handle,
    COUNT(*) FILTER (WHERE lead_minutes_from_first <= 10)::INT,
    COUNT(*)::INT,
    ROUND(AVG(lead_minutes_from_median), 2),
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY lead_minutes_from_median)::NUMERIC, 2),
    ROUND(COUNT(*) FILTER (WHERE lead_minutes_from_first <= 10)::NUMERIC / GREATEST(COUNT(*), 1), 4),
    (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
  FROM author_stats
  GROUP BY handle
  ON CONFLICT (handle) DO UPDATE SET
    mint_starts = EXCLUDED.mint_starts,
    mint_participated = EXCLUDED.mint_participated,
    avg_lead_minutes = EXCLUDED.avg_lead_minutes,
    median_lead_minutes = EXCLUDED.median_lead_minutes,
    lead_ratio = EXCLUDED.lead_ratio,
    updated_at = EXCLUDED.updated_at;

  GET DIAGNOSTICS cnt = ROW_COUNT;
  RETURN cnt;
END $$ LANGUAGE plpgsql;

DROP VIEW IF EXISTS v_lead_authors CASCADE;
CREATE VIEW v_lead_authors AS
SELECT a.handle, a.lead_ratio, a.mint_starts, a.mint_participated,
  a.median_lead_minutes, r.reputation_score, r.is_verified, p.followers
FROM author_lead_stats a
LEFT JOIN author_reputation r ON r.handle = a.handle
LEFT JOIN twitter_profiles p ON p.handle = a.handle
WHERE a.mint_participated >= 5 AND a.lead_ratio >= 0.3
ORDER BY a.lead_ratio DESC, r.reputation_score DESC NULLS LAST;

DROP VIEW IF EXISTS v_author_retention CASCADE;
CREATE VIEW v_author_retention AS
WITH first_seen AS (
  SELECT handle,
    date_trunc('week', to_timestamp(MIN(posted_at) / 1000))::date AS cohort_week,
    MIN(posted_at) AS first_at
  FROM twitter_tweets WHERE posted_at IS NOT NULL GROUP BY handle
),
activity AS (
  SELECT t.handle,
    date_trunc('week', to_timestamp(t.posted_at / 1000))::date AS week,
    COUNT(DISTINCT t.tweet_id) AS tweets
  FROM twitter_tweets t WHERE t.posted_at IS NOT NULL
  GROUP BY t.handle, week
)
SELECT f.cohort_week,
  EXTRACT(WEEK FROM a.week) - EXTRACT(WEEK FROM f.cohort_week) AS week_number,
  COUNT(DISTINCT f.handle) AS authors,
  SUM(a.tweets)::BIGINT AS tweets,
  ROUND(AVG(a.tweets), 2) AS avg_tweets_per_author
FROM first_seen f
JOIN activity a ON a.handle = f.handle
GROUP BY f.cohort_week, week_number
ORDER BY f.cohort_week DESC, week_number;

DROP VIEW IF EXISTS v_weighted_sentiment CASCADE;
CREATE VIEW v_weighted_sentiment AS
SELECT l.mint, COUNT(*)::INT AS tweets,
  ROUND(
    SUM(s.score * COALESCE(r.reputation_score, 50) / 50.0) /
    NULLIF(SUM(COALESCE(r.reputation_score, 50) / 50.0), 0), 4
  ) AS weighted_sentiment,
  ROUND(AVG(s.score), 4) AS raw_sentiment,
  ROUND(
    SUM(s.score * COALESCE(p.followers, 100)) /
    NULLIF(SUM(COALESCE(p.followers, 100)), 0), 4
  ) AS follower_weighted_sentiment
FROM tweet_token_links l
JOIN tweet_sentiment s ON s.tweet_id = l.tweet_id
LEFT JOIN author_reputation r ON r.handle = l.handle
LEFT JOIN twitter_profiles p ON p.handle = l.handle
GROUP BY l.mint;

CREATE TABLE IF NOT EXISTS author_pagerank (
  handle TEXT PRIMARY KEY,
  pagerank NUMERIC(12,10) NOT NULL,
  degree_in INTEGER NOT NULL DEFAULT 0,
  degree_out INTEGER NOT NULL DEFAULT 0,
  iterations INTEGER NOT NULL,
  computed_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pr_score ON author_pagerank(pagerank DESC);

CREATE OR REPLACE FUNCTION rebuild_pagerank(
  p_damping NUMERIC DEFAULT 0.85,
  p_iterations INT DEFAULT 20,
  p_min_weight INT DEFAULT 2
) RETURNS INTEGER AS $$
DECLARE iter INT := 0; cnt INTEGER;
BEGIN
  DROP TABLE IF EXISTS _pr_temp;
  CREATE TEMP TABLE _pr_temp AS
  WITH nodes AS (
    SELECT DISTINCT source AS handle FROM v_author_graph WHERE weight >= p_min_weight
    UNION
    SELECT DISTINCT target FROM v_author_graph WHERE weight >= p_min_weight
  )
  SELECT handle, 1.0 / COUNT(*) OVER () AS pagerank FROM nodes;
  CREATE INDEX ON _pr_temp(handle);

  WHILE iter < p_iterations LOOP
    DROP TABLE IF EXISTS _pr_next;
    CREATE TEMP TABLE _pr_next AS
    WITH out_degrees AS (
      SELECT source, SUM(weight)::NUMERIC AS total
      FROM v_author_graph WHERE weight >= p_min_weight GROUP BY source
    ),
    contributions AS (
      SELECT e.target AS handle,
        SUM(p.pagerank * e.weight / o.total) AS contrib
      FROM v_author_graph e
      JOIN _pr_temp p ON p.handle = e.source
      JOIN out_degrees o ON o.source = e.source
      WHERE e.weight >= p_min_weight
      GROUP BY e.target
    ),
    total_nodes AS (SELECT COUNT(*)::NUMERIC AS n FROM _pr_temp)
    SELECT t.handle,
      (1 - p_damping) / tn.n + p_damping * COALESCE(c.contrib, 0) AS pagerank
    FROM _pr_temp t
    CROSS JOIN total_nodes tn
    LEFT JOIN contributions c ON c.handle = t.handle;

    DROP TABLE _pr_temp;
    ALTER TABLE _pr_next RENAME TO _pr_temp;
    iter := iter + 1;
  END LOOP;

  DELETE FROM author_pagerank;
  INSERT INTO author_pagerank (handle, pagerank, degree_in, degree_out, iterations, computed_at)
  SELECT t.handle, t.pagerank,
    COALESCE((SELECT COUNT(*) FROM v_author_graph WHERE target = t.handle AND weight >= p_min_weight), 0),
    COALESCE((SELECT COUNT(*) FROM v_author_graph WHERE source = t.handle AND weight >= p_min_weight), 0),
    p_iterations,
    (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
  FROM _pr_temp t;

  GET DIAGNOSTICS cnt = ROW_COUNT;
  DROP TABLE IF EXISTS _pr_temp;
  RETURN cnt;
END $$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS backtest_runs (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL, params JSONB NOT NULL,
  started_at BIGINT NOT NULL, finished_at BIGINT,
  signals_count INTEGER,
  avg_return_pct NUMERIC(10,4), median_return NUMERIC(10,4),
  win_rate NUMERIC(5,4), sharpe NUMERIC(10,4), max_drawdown NUMERIC(10,4),
  metric_basis TEXT NOT NULL DEFAULT 'legacy_unknown',
  avg_views_change_pct NUMERIC(10,4), median_views_change_pct NUMERIC(10,4),
  positive_attention_rate NUMERIC(5,4), min_views_change_pct NUMERIC(10,4),
  notes TEXT
);

CREATE TABLE IF NOT EXISTS backtest_trades (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
  mint TEXT NOT NULL, signal_at BIGINT NOT NULL,
  entry_score NUMERIC(8,4) NOT NULL,
  entry_views BIGINT, exit_views BIGINT,
  return_pct NUMERIC(10,4), views_change_pct NUMERIC(10,4),
  hold_hours INTEGER, metadata JSONB
);
CREATE INDEX IF NOT EXISTS idx_bt_run ON backtest_trades(run_id);

CREATE OR REPLACE FUNCTION backtest_hype_threshold(
  p_run_name TEXT, p_threshold NUMERIC DEFAULT 60,
  p_hold_hours INT DEFAULT 6, p_from_ms BIGINT DEFAULT NULL
) RETURNS BIGINT AS $$
DECLARE
  run_id BIGINT;
  from_ts BIGINT := COALESCE(p_from_ms, (EXTRACT(EPOCH FROM NOW()) * 1000 - 30 * 86400000)::BIGINT);
BEGIN
  INSERT INTO backtest_runs (name, params, started_at)
  VALUES (p_run_name, jsonb_build_object('threshold', p_threshold, 'hold_hours', p_hold_hours),
          (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT)
  RETURNING id INTO run_id;

  INSERT INTO backtest_trades (run_id, mint, signal_at, entry_score, entry_views, exit_views, return_pct, hold_hours)
  WITH crossings AS (
    SELECT DISTINCT ON (mint) mint, computed_at AS signal_at, hype_score AS entry_score
    FROM mint_hype_scores
    WHERE hype_score >= p_threshold AND computed_at >= from_ts
    ORDER BY mint, computed_at ASC
  )
  SELECT run_id, c.mint, c.signal_at, c.entry_score,
    (SELECT COALESCE(SUM(views), 0) FROM mint_metrics_1h
     WHERE mint = c.mint AND bucket <= c.signal_at AND bucket > c.signal_at - 3600000),
    (SELECT COALESCE(SUM(views), 0) FROM mint_metrics_1h
     WHERE mint = c.mint AND bucket >= c.signal_at + (p_hold_hours * 3600000)
       AND bucket < c.signal_at + ((p_hold_hours + 1) * 3600000)),
    NULL, p_hold_hours
  FROM crossings c;

  UPDATE backtest_trades SET return_pct =
    CASE WHEN entry_views > 0
         THEN ROUND(((exit_views::NUMERIC - entry_views) / entry_views) * 100, 4)
         ELSE 0 END
  WHERE backtest_trades.run_id = backtest_hype_threshold.run_id;

  UPDATE backtest_runs SET
    finished_at = (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
    signals_count = (SELECT COUNT(*) FROM backtest_trades WHERE run_id = backtest_runs.id),
    avg_return_pct = (SELECT ROUND(AVG(return_pct), 4) FROM backtest_trades WHERE run_id = backtest_runs.id),
    median_return = (SELECT ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY return_pct)::NUMERIC, 4)
                     FROM backtest_trades WHERE run_id = backtest_runs.id),
    win_rate = (SELECT ROUND(AVG(CASE WHEN return_pct > 0 THEN 1.0 ELSE 0.0 END), 4)
                FROM backtest_trades WHERE run_id = backtest_runs.id),
    sharpe = (SELECT CASE WHEN STDDEV_POP(return_pct) > 0
                          THEN ROUND(AVG(return_pct) / STDDEV_POP(return_pct), 4)
                          ELSE 0 END
              FROM backtest_trades WHERE run_id = backtest_runs.id),
    max_drawdown = (SELECT ROUND(MIN(return_pct), 4) FROM backtest_trades WHERE run_id = backtest_runs.id)
  WHERE id = run_id;

  RETURN run_id;
END $$ LANGUAGE plpgsql;

