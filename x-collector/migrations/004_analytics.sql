-- ЗАВИСИТ ОТ: 001, 002. Порядок применения: 001 → 002 → 004

DROP VIEW IF EXISTS v_mint_summary CASCADE;
CREATE VIEW v_mint_summary AS
SELECT l.mint,
  COUNT(DISTINCT t.tweet_id)::INT AS total_tweets,
  COUNT(DISTINCT t.handle)::INT AS unique_authors,
  COUNT(DISTINCT CASE WHEN t.is_verified THEN t.handle END)::INT AS verified_authors,
  COALESCE(SUM(t.views), 0)::BIGINT AS total_views,
  COALESCE(SUM(t.likes), 0)::BIGINT AS total_likes,
  COALESCE(SUM(t.retweets), 0)::BIGINT AS total_retweets,
  MIN(t.posted_at) AS first_mention_at,
  MAX(t.posted_at) AS last_mention_at,
  MAX(t.posted_at) - MIN(t.posted_at) AS lifespan_ms
FROM tweet_token_links l
JOIN twitter_tweets t ON t.tweet_id = l.tweet_id
GROUP BY l.mint;

DROP VIEW IF EXISTS v_mint_daily_funnel CASCADE;
CREATE VIEW v_mint_daily_funnel AS
SELECT l.mint,
  to_char(to_timestamp(t.posted_at / 1000), 'YYYY-MM-DD') AS day,
  COUNT(DISTINCT t.tweet_id)::INT AS tweets,
  COUNT(DISTINCT t.handle)::INT AS authors,
  COALESCE(SUM(t.views), 0)::BIGINT AS views,
  COALESCE(SUM(t.likes), 0)::BIGINT AS likes,
  COALESCE(SUM(t.retweets), 0)::BIGINT AS retweets,
  CASE WHEN SUM(t.views) > 0 THEN ROUND((SUM(t.likes)::NUMERIC / SUM(t.views)) * 100, 2) ELSE 0 END AS like_rate_pct,
  CASE WHEN SUM(t.views) > 0 THEN ROUND((SUM(t.retweets)::NUMERIC / SUM(t.views)) * 100, 2) ELSE 0 END AS rt_rate_pct
FROM tweet_token_links l
JOIN twitter_tweets t ON t.tweet_id = l.tweet_id
WHERE t.posted_at IS NOT NULL
GROUP BY l.mint, day;

DROP VIEW IF EXISTS v_mint_bursts CASCADE;
CREATE VIEW v_mint_bursts AS
WITH hourly AS (
  SELECT l.mint,
    (t.posted_at / 3600000)::BIGINT AS hour_bucket,
    COUNT(DISTINCT t.tweet_id)::INT AS tweets,
    COUNT(DISTINCT t.handle)::INT AS authors
  FROM tweet_token_links l
  JOIN twitter_tweets t ON t.tweet_id = l.tweet_id
  WHERE t.posted_at IS NOT NULL
  GROUP BY l.mint, hour_bucket
),
with_lag AS (
  SELECT mint, hour_bucket, tweets, authors,
    LAG(tweets, 1) OVER (PARTITION BY mint ORDER BY hour_bucket) AS prev_tweets,
    LAG(tweets, 6) OVER (PARTITION BY mint ORDER BY hour_bucket) AS tweets_6h_ago
  FROM hourly
)
SELECT mint,
  hour_bucket * 3600000 AS hour_start_ms,
  tweets, authors,
  COALESCE(prev_tweets, 0) AS prev_hour_tweets,
  CASE WHEN COALESCE(prev_tweets, 0) > 0 THEN ROUND(tweets::NUMERIC / prev_tweets, 2) ELSE NULL END AS growth_x,
  CASE WHEN COALESCE(tweets_6h_ago, 0) > 0 THEN ROUND(tweets::NUMERIC / tweets_6h_ago, 2) ELSE NULL END AS growth_6h_x
FROM with_lag
WHERE tweets >= 5
  AND (prev_tweets IS NULL OR tweets::NUMERIC / GREATEST(prev_tweets, 1) >= 3);

DROP VIEW IF EXISTS v_top_tweets CASCADE;
CREATE VIEW v_top_tweets AS
SELECT t.tweet_id, t.handle, t.text, t.url, t.views, t.likes, t.retweets, t.replies,
  t.posted_at, t.is_verified,
  (COALESCE(t.likes, 0) + COALESCE(t.retweets, 0) * 3 + COALESCE(t.replies, 0) * 2)::BIGINT AS engagement_score,
  array_agg(DISTINCT l.mint) FILTER (WHERE l.mint IS NOT NULL) AS mints
FROM twitter_tweets t
LEFT JOIN tweet_token_links l ON l.tweet_id = t.tweet_id
WHERE t.views > 0
GROUP BY t.tweet_id;

DROP VIEW IF EXISTS v_author_profile CASCADE;
CREATE VIEW v_author_profile AS
SELECT t.handle,
  COUNT(DISTINCT t.tweet_id)::INT AS total_tweets,
  COUNT(DISTINCT l.mint)::INT AS mints_promoted,
  COALESCE(SUM(t.views), 0)::BIGINT AS total_views,
  COALESCE(SUM(t.likes), 0)::BIGINT AS total_likes,
  COALESCE(SUM(t.retweets), 0)::BIGINT AS total_retweets,
  ROUND(AVG(t.views), 2) AS avg_views_per_tweet,
  ROUND(AVG(t.likes), 2) AS avg_likes_per_tweet,
  MIN(t.posted_at) AS first_seen_at,
  MAX(t.posted_at) AS last_seen_at,
  BOOL_OR(t.is_verified) AS is_verified,
  CASE WHEN SUM(t.views) > 0 THEN ROUND((SUM(t.likes)::NUMERIC / SUM(t.views)) * 100, 2) ELSE 0 END AS engagement_pct
FROM twitter_tweets t
LEFT JOIN tweet_token_links l ON l.tweet_id = t.tweet_id
GROUP BY t.handle;

DROP VIEW IF EXISTS v_shillers CASCADE;
CREATE VIEW v_shillers AS
SELECT handle, mints_promoted, total_tweets, total_views, avg_views_per_tweet,
       engagement_pct, is_verified, first_seen_at, last_seen_at
FROM v_author_profile
WHERE mints_promoted >= 3
ORDER BY mints_promoted DESC, total_views DESC;

DROP VIEW IF EXISTS v_fresh_burners CASCADE;
CREATE VIEW v_fresh_burners AS
SELECT handle, mints_promoted, total_tweets, total_views, first_seen_at, last_seen_at
FROM v_author_profile
WHERE mints_promoted = 1
  AND last_seen_at > (EXTRACT(EPOCH FROM NOW()) * 1000 - 7 * 86400000)::BIGINT
ORDER BY total_views DESC;

DROP VIEW IF EXISTS v_rising_authors CASCADE;
CREATE VIEW v_rising_authors AS
WITH recent AS (
  SELECT handle, COUNT(*) AS recent_tweets, COALESCE(SUM(views), 0) AS recent_views
  FROM twitter_tweets
  WHERE first_seen_at > (EXTRACT(EPOCH FROM NOW()) * 1000 - 7 * 86400000)::BIGINT
  GROUP BY handle
),
old AS (
  SELECT handle, COUNT(*) AS old_tweets, COALESCE(SUM(views), 0) AS old_views
  FROM twitter_tweets
  WHERE first_seen_at <= (EXTRACT(EPOCH FROM NOW()) * 1000 - 7 * 86400000)::BIGINT
  GROUP BY handle
)
SELECT r.handle, r.recent_tweets, r.recent_views,
  COALESCE(o.old_tweets, 0) AS old_tweets,
  COALESCE(o.old_views, 0) AS old_views,
  CASE WHEN COALESCE(o.old_views, 0) > 0 THEN ROUND(r.recent_views::NUMERIC / o.old_views, 2) ELSE NULL END AS growth_x
FROM recent r
LEFT JOIN old o ON o.handle = r.handle
WHERE r.recent_views > 10000
  AND (o.old_views IS NULL OR r.recent_views > o.old_views * 3);

DROP VIEW IF EXISTS v_coordinated_tweets CASCADE;
CREATE VIEW v_coordinated_tweets AS
WITH normalized AS (
  SELECT t.handle, l.mint,
    regexp_replace(lower(text), '\s+', ' ', 'g') AS norm_text
  FROM twitter_tweets t
  JOIN tweet_token_links l ON l.tweet_id = t.tweet_id
),
clusters AS (
  SELECT mint, md5(norm_text) AS text_hash,
    array_agg(DISTINCT handle) AS handles,
    COUNT(DISTINCT handle) AS author_count,
    MIN(norm_text) AS sample_text
  FROM normalized
  WHERE length(norm_text) > 30
  GROUP BY mint, md5(norm_text)
)
SELECT mint, text_hash, handles, author_count, sample_text
FROM clusters
WHERE author_count >= 3
ORDER BY author_count DESC;

DROP VIEW IF EXISTS v_coordinated_accounts CASCADE;
CREATE VIEW v_coordinated_accounts AS
SELECT handle,
  COUNT(DISTINCT mint) AS involved_mints,
  COUNT(*) AS coordinated_posts,
  array_agg(DISTINCT mint) AS mints
FROM (
  SELECT unnest(handles) AS handle, mint FROM v_coordinated_tweets
) x
GROUP BY handle
ORDER BY involved_mints DESC, coordinated_posts DESC;

DROP VIEW IF EXISTS v_author_graph CASCADE;
CREATE VIEW v_author_graph AS
SELECT a.handle AS source, b.handle AS target,
  COUNT(DISTINCT a.mint) AS weight,
  array_agg(DISTINCT a.mint) AS shared_mints
FROM tweet_token_links a
JOIN tweet_token_links b ON a.mint = b.mint AND a.handle < b.handle
GROUP BY a.handle, b.handle
HAVING COUNT(DISTINCT a.mint) >= 2
ORDER BY weight DESC;

DROP VIEW IF EXISTS v_hourly_activity CASCADE;
CREATE VIEW v_hourly_activity AS
SELECT EXTRACT(HOUR FROM to_timestamp(posted_at / 1000))::INT AS hour_utc,
  COUNT(*)::INT AS tweets,
  COUNT(DISTINCT handle)::INT AS authors,
  COALESCE(SUM(views), 0)::BIGINT AS total_views
FROM twitter_tweets
WHERE posted_at IS NOT NULL
GROUP BY hour_utc
ORDER BY hour_utc;

DROP VIEW IF EXISTS v_mint_overlap CASCADE;
CREATE VIEW v_mint_overlap AS
WITH pairs AS (
  SELECT LEAST(a.mint, b.mint) AS mint_a,
         GREATEST(a.mint, b.mint) AS mint_b,
         a.handle
  FROM tweet_token_links a
  JOIN tweet_token_links b ON a.handle = b.handle AND a.mint != b.mint
)
SELECT mint_a, mint_b, COUNT(DISTINCT handle)::INT AS shared_authors
FROM pairs
GROUP BY mint_a, mint_b
HAVING COUNT(DISTINCT handle) >= 5
ORDER BY shared_authors DESC;

DROP VIEW IF EXISTS v_trending_words CASCADE;
CREATE VIEW v_trending_words AS
SELECT word, COUNT(*)::INT AS occurrences, COUNT(DISTINCT handle)::INT AS authors
FROM (
  SELECT handle,
    unnest(regexp_split_to_array(
      lower(regexp_replace(text, '[^a-zA-Z0-9$#@_ ]', ' ', 'g')), '\s+'
    )) AS word
  FROM twitter_tweets
  WHERE first_seen_at > (EXTRACT(EPOCH FROM NOW()) * 1000 - 7 * 86400000)::BIGINT
) x
WHERE length(word) >= 4
  AND word NOT IN ('that','this','with','from','have','they','will','your','just',
                   'what','when','been','like','about','some','more','than','only',
                   'also','into','them','then','very','much','make','made','here')
GROUP BY word
HAVING COUNT(*) >= 20
ORDER BY occurrences DESC;

DROP VIEW IF EXISTS v_cashtag_trends CASCADE;
CREATE VIEW v_cashtag_trends AS
SELECT tag, COUNT(*)::INT AS mentions, COUNT(DISTINCT handle)::INT AS authors,
  COALESCE(SUM(views), 0)::BIGINT AS total_views
FROM (
  SELECT handle, views, unnest(regexp_matches(text, '\$([A-Z]{2,10})', 'g')) AS tag
  FROM twitter_tweets
  WHERE first_seen_at > (EXTRACT(EPOCH FROM NOW()) * 1000 - 7 * 86400000)::BIGINT
) x
GROUP BY tag
HAVING COUNT(*) >= 10
ORDER BY mentions DESC;

DROP VIEW IF EXISTS v_mint_lifecycle CASCADE;
CREATE VIEW v_mint_lifecycle AS
SELECT l.mint,
  (t.posted_at - first_m.first_mention) / 3600000 AS hours_since_launch,
  COUNT(DISTINCT t.tweet_id)::INT AS tweets,
  COUNT(DISTINCT t.handle)::INT AS authors,
  COALESCE(SUM(t.views), 0)::BIGINT AS views
FROM tweet_token_links l
JOIN twitter_tweets t ON t.tweet_id = l.tweet_id
JOIN (
  SELECT l2.mint, MIN(t2.posted_at) AS first_mention
  FROM tweet_token_links l2
  JOIN twitter_tweets t2 ON t2.tweet_id = l2.tweet_id
  WHERE t2.posted_at IS NOT NULL
  GROUP BY l2.mint
) first_m ON first_m.mint = l.mint
WHERE t.posted_at IS NOT NULL
GROUP BY l.mint, hours_since_launch
ORDER BY l.mint, hours_since_launch;

DROP VIEW IF EXISTS v_worker_efficiency CASCADE;
CREATE VIEW v_worker_efficiency AS
SELECT w.id, w.status, w.tasks_done, w.tasks_failed,
  CASE WHEN w.tasks_done + w.tasks_failed > 0
       THEN ROUND(w.tasks_done::NUMERIC / (w.tasks_done + w.tasks_failed) * 100, 2)
       ELSE 0 END AS success_rate_pct,
  (EXTRACT(EPOCH FROM NOW()) * 1000 - w.started_at) / 3600000 AS uptime_hours,
  w.last_heartbeat
FROM x_workers w
ORDER BY w.tasks_done DESC;

DROP VIEW IF EXISTS v_account_health CASCADE;
CREATE VIEW v_account_health AS
SELECT a.name, a.tier, a.status, a.total_requests, a.total_errors,
  CASE WHEN a.total_requests > 0
       THEN ROUND(a.total_errors::NUMERIC / a.total_requests * 100, 2)
       ELSE 0 END AS error_rate_pct,
  a.consecutive_errors, a.weight_used_this_hour, a.weight_quota_per_hour,
  CASE WHEN a.weight_quota_per_hour > 0
       THEN ROUND(a.weight_used_this_hour::NUMERIC / a.weight_quota_per_hour * 100, 2)
       ELSE 0 END AS quota_used_pct,
  (GREATEST(0, a.cooldown_until - (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT)) / 1000 AS cooldown_sec
FROM x_accounts a
ORDER BY error_rate_pct DESC NULLS LAST, a.name;

DROP VIEW IF EXISTS v_pipeline_daily CASCADE;
CREATE VIEW v_pipeline_daily AS
SELECT to_char(to_timestamp(first_seen_at / 1000), 'YYYY-MM-DD') AS day,
  COUNT(DISTINCT tweet_id)::INT AS tweets_collected,
  COUNT(DISTINCT handle)::INT AS unique_authors,
  COUNT(DISTINCT source_query)::INT AS unique_queries
FROM twitter_tweets
GROUP BY day
ORDER BY day DESC;

CREATE OR REPLACE FUNCTION report_mint(p_mint TEXT)
RETURNS TABLE (section TEXT, metric TEXT, value TEXT) AS $$
BEGIN
  RETURN QUERY SELECT 'summary'::TEXT, 'total_tweets', s.total_tweets::TEXT FROM v_mint_summary s WHERE s.mint = p_mint;
  RETURN QUERY SELECT 'summary'::TEXT, 'unique_authors', s.unique_authors::TEXT FROM v_mint_summary s WHERE s.mint = p_mint;
  RETURN QUERY SELECT 'summary'::TEXT, 'total_views', s.total_views::TEXT FROM v_mint_summary s WHERE s.mint = p_mint;
  RETURN QUERY SELECT 'summary'::TEXT, 'lifespan_hours',
         ROUND(s.lifespan_ms::NUMERIC / 3600000, 2)::TEXT FROM v_mint_summary s WHERE s.mint = p_mint;

  RETURN QUERY SELECT 'top_author'::TEXT, a.handle, a.total_views::TEXT
  FROM mv_author_token_stats a WHERE a.mint = p_mint
  ORDER BY a.total_views DESC LIMIT 5;

  RETURN QUERY SELECT 'burst'::TEXT,
         to_char(to_timestamp(b.hour_start_ms / 1000), 'YYYY-MM-DD HH24:00'),
         b.tweets::TEXT
  FROM v_mint_bursts b WHERE b.mint = p_mint
  ORDER BY b.hour_start_ms DESC LIMIT 5;
END $$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION detect_coordination(p_mint TEXT, min_authors INT DEFAULT 3)
RETURNS TABLE (text_hash TEXT, authors TEXT[], author_cnt INT, sample TEXT) AS $$
BEGIN
  RETURN QUERY
  SELECT md5(regexp_replace(lower(t.text), '\s+', ' ', 'g')) AS text_hash,
    array_agg(DISTINCT t.handle) AS authors,
    COUNT(DISTINCT t.handle)::INT AS author_cnt,
    MIN(t.text) AS sample
  FROM twitter_tweets t
  JOIN tweet_token_links l ON l.tweet_id = t.tweet_id
  WHERE l.mint = p_mint AND length(t.text) > 30
  GROUP BY text_hash
  HAVING COUNT(DISTINCT t.handle) >= min_authors
  ORDER BY author_cnt DESC
  LIMIT 50;
END $$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION mint_timeseries(p_mint TEXT, p_interval_ms BIGINT DEFAULT 3600000)
RETURNS TABLE (bucket BIGINT, tweets INT, authors INT, views BIGINT, likes BIGINT) AS $$
BEGIN
  RETURN QUERY
  SELECT ((t.posted_at / p_interval_ms) * p_interval_ms)::BIGINT AS bucket,
    COUNT(DISTINCT t.tweet_id)::INT AS tweets,
    COUNT(DISTINCT t.handle)::INT AS authors,
    COALESCE(SUM(t.views), 0)::BIGINT AS views,
    COALESCE(SUM(t.likes), 0)::BIGINT AS likes
  FROM tweet_token_links l
  JOIN twitter_tweets t ON t.tweet_id = l.tweet_id
  WHERE l.mint = p_mint AND t.posted_at IS NOT NULL
  GROUP BY bucket
  ORDER BY bucket;
END $$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION top_authors_by_views(p_limit INT DEFAULT 50)
RETURNS TABLE (handle TEXT, mints INT, tweets INT, total_views BIGINT, avg_views NUMERIC, is_verified BOOLEAN) AS $$
BEGIN
  RETURN QUERY
  SELECT a.handle, a.mints_promoted AS mints, a.total_tweets AS tweets,
    a.total_views, a.avg_views_per_tweet AS avg_views, a.is_verified
  FROM v_author_profile a
  WHERE a.mints_promoted >= 2
  ORDER BY a.total_views DESC
  LIMIT p_limit;
END $$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION daily_digest(p_day DATE DEFAULT CURRENT_DATE)
RETURNS TABLE (metric TEXT, value BIGINT) AS $$
DECLARE
  start_ms BIGINT := (EXTRACT(EPOCH FROM p_day::timestamp) * 1000)::BIGINT;
  end_ms BIGINT := start_ms + 86400000;
BEGIN
  RETURN QUERY SELECT 'tweets'::TEXT, COUNT(*)::BIGINT FROM twitter_tweets
    WHERE first_seen_at >= start_ms AND first_seen_at < end_ms;
  RETURN QUERY SELECT 'authors'::TEXT, COUNT(DISTINCT handle)::BIGINT FROM twitter_tweets
    WHERE first_seen_at >= start_ms AND first_seen_at < end_ms;
  RETURN QUERY SELECT 'mints'::TEXT, COUNT(DISTINCT mint)::BIGINT FROM tweet_token_links
    WHERE linked_at >= start_ms AND linked_at < end_ms;
  RETURN QUERY SELECT 'tasks_done'::TEXT, COALESCE(SUM(tasks_done), 0)::BIGINT FROM x_workers;
  RETURN QUERY SELECT 'dlq_new'::TEXT, COUNT(*)::BIGINT FROM x_tasks_dlq
    WHERE failed_at >= start_ms AND failed_at < end_ms;
END $$ LANGUAGE plpgsql STABLE;

DROP MATERIALIZED VIEW IF EXISTS mv_top_authors CASCADE;
CREATE MATERIALIZED VIEW mv_top_authors AS
SELECT * FROM v_author_profile WHERE total_views > 1000;
CREATE UNIQUE INDEX IF NOT EXISTS mv_top_authors_pk ON mv_top_authors(handle);
CREATE INDEX IF NOT EXISTS mv_top_authors_views ON mv_top_authors(total_views DESC);

DROP MATERIALIZED VIEW IF EXISTS mv_shillers CASCADE;
CREATE MATERIALIZED VIEW mv_shillers AS SELECT * FROM v_shillers;
CREATE UNIQUE INDEX IF NOT EXISTS mv_shillers_pk ON mv_shillers(handle);
CREATE INDEX IF NOT EXISTS mv_shillers_mints ON mv_shillers(mints_promoted DESC);

DROP MATERIALIZED VIEW IF EXISTS mv_coordinated CASCADE;
CREATE MATERIALIZED VIEW mv_coordinated AS SELECT * FROM v_coordinated_accounts;
CREATE UNIQUE INDEX IF NOT EXISTS mv_coordinated_pk ON mv_coordinated(handle);

CREATE OR REPLACE FUNCTION refresh_all_mvs() RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_author_token_stats;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_author_cooccurrence;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_mint_stats;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_top_authors;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_shillers;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_coordinated;
END $$ LANGUAGE plpgsql;