CREATE TABLE IF NOT EXISTS mint_metrics_1m (
  mint TEXT NOT NULL, bucket BIGINT NOT NULL,
  tweets INTEGER NOT NULL DEFAULT 0, authors INTEGER NOT NULL DEFAULT 0,
  views BIGINT NOT NULL DEFAULT 0, likes BIGINT NOT NULL DEFAULT 0,
  retweets BIGINT NOT NULL DEFAULT 0, sentiment NUMERIC(5,4),
  PRIMARY KEY (mint, bucket)
);

CREATE TABLE IF NOT EXISTS mint_metrics_1h (
  mint TEXT NOT NULL, bucket BIGINT NOT NULL,
  tweets INTEGER NOT NULL DEFAULT 0, authors INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0,
  views BIGINT NOT NULL DEFAULT 0, likes BIGINT NOT NULL DEFAULT 0,
  retweets BIGINT NOT NULL DEFAULT 0, sentiment NUMERIC(5,4),
  stddev_sentiment NUMERIC(5,4),
  spam_count INTEGER NOT NULL DEFAULT 0, scam_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (mint, bucket)
);

CREATE TABLE IF NOT EXISTS mint_metrics_1d (
  mint TEXT NOT NULL, bucket BIGINT NOT NULL,
  tweets INTEGER NOT NULL DEFAULT 0, authors INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0,
  views BIGINT NOT NULL DEFAULT 0, likes BIGINT NOT NULL DEFAULT 0,
  retweets BIGINT NOT NULL DEFAULT 0, sentiment NUMERIC(5,4),
  peak_hour INTEGER, burst_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (mint, bucket)
);
CREATE INDEX IF NOT EXISTS idx_mm1d_bucket ON mint_metrics_1d(bucket DESC);

CREATE TABLE IF NOT EXISTS mint_metrics_1w (
  mint TEXT NOT NULL, bucket BIGINT NOT NULL,
  tweets INTEGER NOT NULL DEFAULT 0, authors INTEGER NOT NULL DEFAULT 0,
  views BIGINT NOT NULL DEFAULT 0, sentiment NUMERIC(5,4),
  PRIMARY KEY (mint, bucket)
);

CREATE TABLE IF NOT EXISTS author_metrics_1d (
  handle TEXT NOT NULL, bucket BIGINT NOT NULL,
  tweets INTEGER NOT NULL DEFAULT 0, views BIGINT NOT NULL DEFAULT 0,
  likes BIGINT NOT NULL DEFAULT 0, retweets BIGINT NOT NULL DEFAULT 0,
  mints INTEGER NOT NULL DEFAULT 0, sentiment NUMERIC(5,4),
  PRIMARY KEY (handle, bucket)
);

CREATE OR REPLACE FUNCTION rollup_mint_1d(p_from BIGINT DEFAULT NULL, p_to BIGINT DEFAULT NULL)
RETURNS INTEGER AS $$
DECLARE
  from_ts BIGINT := COALESCE(p_from, (EXTRACT(EPOCH FROM NOW()) * 1000 - 7 * 86400000)::BIGINT);
  to_ts BIGINT := COALESCE(p_to, (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT);
  cnt INTEGER;
BEGIN
  INSERT INTO mint_metrics_1d (
    mint, bucket, tweets, authors, verified, views, likes, retweets,
    sentiment, peak_hour, burst_count
  )
  SELECT mint,
    (bucket / 86400000) * 86400000 AS day_bucket,
    SUM(tweets), MAX(authors), MAX(verified),
    SUM(views), SUM(likes), SUM(retweets),
    ROUND(AVG(sentiment), 4),
    (SELECT (bucket / 3600000 % 24)::INT FROM mint_metrics_1h m2
     WHERE m2.mint = mint_metrics_1h.mint
       AND m2.bucket / 86400000 = mint_metrics_1h.bucket / 86400000
     ORDER BY tweets DESC LIMIT 1),
    COUNT(*) FILTER (WHERE tweets >= 100)
  FROM mint_metrics_1h
  WHERE bucket >= from_ts AND bucket < to_ts
  GROUP BY mint, day_bucket
  ON CONFLICT (mint, bucket) DO UPDATE SET
    tweets = EXCLUDED.tweets, authors = EXCLUDED.authors,
    verified = EXCLUDED.verified, views = EXCLUDED.views,
    likes = EXCLUDED.likes, retweets = EXCLUDED.retweets,
    sentiment = EXCLUDED.sentiment, peak_hour = EXCLUDED.peak_hour,
    burst_count = EXCLUDED.burst_count;

  GET DIAGNOSTICS cnt = ROW_COUNT;
  RETURN cnt;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION rebuild_mint_metrics_1m(p_from BIGINT DEFAULT NULL)
RETURNS INTEGER AS $$
DECLARE
  from_ts BIGINT := COALESCE(p_from, (EXTRACT(EPOCH FROM NOW()) * 1000 - 86400000)::BIGINT);
  cnt INTEGER;
BEGIN
  INSERT INTO mint_metrics_1m (mint, bucket, tweets, authors, views, likes, retweets, sentiment)
  SELECT l.mint,
    (t.posted_at / 60000) * 60000 AS bucket,
    COUNT(DISTINCT t.tweet_id),
    COUNT(DISTINCT t.handle),
    COALESCE(SUM(t.views), 0),
    COALESCE(SUM(t.likes), 0),
    COALESCE(SUM(t.retweets), 0),
    ROUND(AVG(s.score), 4)
  FROM tweet_token_links l
  JOIN twitter_tweets t ON t.tweet_id = l.tweet_id
  LEFT JOIN tweet_sentiment s ON s.tweet_id = t.tweet_id
  WHERE t.posted_at >= from_ts
  GROUP BY l.mint, bucket
  ON CONFLICT (mint, bucket) DO UPDATE SET
    tweets = EXCLUDED.tweets, authors = EXCLUDED.authors,
    views = EXCLUDED.views, likes = EXCLUDED.likes,
    retweets = EXCLUDED.retweets, sentiment = EXCLUDED.sentiment;

  GET DIAGNOSTICS cnt = ROW_COUNT;
  RETURN cnt;
END $$ LANGUAGE plpgsql;

DROP VIEW IF EXISTS v_mint_anomalies CASCADE;
CREATE VIEW v_mint_anomalies AS
WITH stats AS (
  SELECT mint,
    AVG(tweets) AS avg_tweets,
    STDDEV_POP(tweets) AS std_tweets
  FROM mint_metrics_1h
  WHERE bucket > (EXTRACT(EPOCH FROM NOW()) * 1000 - 7 * 86400000)::BIGINT
  GROUP BY mint
)
SELECT m.mint, m.bucket, m.tweets,
  ROUND(s.avg_tweets, 2) AS baseline,
  ROUND((m.tweets - s.avg_tweets) / GREATEST(s.std_tweets, 1), 2) AS z_score,
  CASE
    WHEN (m.tweets - s.avg_tweets) / GREATEST(s.std_tweets, 1) >= 3 THEN 'extreme_high'
    WHEN (m.tweets - s.avg_tweets) / GREATEST(s.std_tweets, 1) >= 2 THEN 'high'
    WHEN (m.tweets - s.avg_tweets) / GREATEST(s.std_tweets, 1) <= -2 THEN 'low'
    ELSE 'normal'
  END AS anomaly
FROM mint_metrics_1h m
JOIN stats s ON s.mint = m.mint
WHERE ABS((m.tweets - s.avg_tweets) / GREATEST(s.std_tweets, 1)) >= 2
ORDER BY z_score DESC;