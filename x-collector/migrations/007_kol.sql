CREATE TABLE IF NOT EXISTS kol_tiers (
  tier TEXT PRIMARY KEY,
  min_followers BIGINT NOT NULL,
  weight NUMERIC(4,2) NOT NULL
);
INSERT INTO kol_tiers VALUES
  ('nano', 1000, 1.0),
  ('micro', 10000, 1.5),
  ('mid', 50000, 2.5),
  ('macro', 200000, 4.0),
  ('mega', 1000000, 7.0)
ON CONFLICT (tier) DO NOTHING;

CREATE TABLE IF NOT EXISTS author_reputation (
  handle TEXT PRIMARY KEY,
  total_mints INTEGER NOT NULL DEFAULT 0,
  mints_pumped INTEGER NOT NULL DEFAULT 0,
  mints_rugged INTEGER NOT NULL DEFAULT 0,
  avg_views NUMERIC(14,2),
  median_views NUMERIC(14,2),
  reply_rate NUMERIC(5,4),
  engagement_rate NUMERIC(5,4),
  reputation_score NUMERIC(5,2) NOT NULL DEFAULT 50,
  tier TEXT,
  is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  spam_ratio NUMERIC(5,4) NOT NULL DEFAULT 0,
  scam_ratio NUMERIC(5,4) NOT NULL DEFAULT 0,
  first_seen_at BIGINT,
  last_seen_at BIGINT,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rep_score ON author_reputation(reputation_score DESC);
CREATE INDEX IF NOT EXISTS idx_rep_tier ON author_reputation(tier, reputation_score DESC);

CREATE OR REPLACE FUNCTION rebuild_author_reputation() RETURNS INTEGER AS $$
DECLARE cnt INTEGER;
BEGIN
  INSERT INTO author_reputation (
    handle, total_mints, avg_views, median_views, engagement_rate,
    spam_ratio, scam_ratio, is_verified, first_seen_at, last_seen_at, updated_at
  )
  SELECT
    p.handle, p.mints_promoted,
    ROUND(AVG(t.views), 2),
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY t.views),
    CASE WHEN SUM(t.views) > 0
         THEN ROUND((SUM(t.likes + t.retweets)::NUMERIC / SUM(t.views)), 4)
         ELSE 0 END,
    COALESCE(AVG(tox.spam_score), 0),
    COALESCE(AVG(tox.scam_score), 0),
    BOOL_OR(t.is_verified),
    p.first_seen_at, p.last_seen_at,
    (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
  FROM v_author_profile p
  LEFT JOIN twitter_tweets t ON t.handle = p.handle
  LEFT JOIN tweet_toxicity tox ON tox.tweet_id = t.tweet_id
  GROUP BY p.handle, p.mints_promoted, p.first_seen_at, p.last_seen_at
  ON CONFLICT (handle) DO UPDATE SET
    total_mints = EXCLUDED.total_mints,
    avg_views = EXCLUDED.avg_views,
    median_views = EXCLUDED.median_views,
    engagement_rate = EXCLUDED.engagement_rate,
    spam_ratio = EXCLUDED.spam_ratio,
    scam_ratio = EXCLUDED.scam_ratio,
    is_verified = EXCLUDED.is_verified,
    last_seen_at = EXCLUDED.last_seen_at,
    updated_at = EXCLUDED.updated_at;

  GET DIAGNOSTICS cnt = ROW_COUNT;

  UPDATE author_reputation SET
    reputation_score = GREATEST(0, LEAST(100,
      50
      + CASE WHEN is_verified THEN 15 ELSE 0 END
      + LEAST(total_mints * 2, 20)
      + LEAST(COALESCE(engagement_rate, 0) * 200, 15)
      - LEAST(spam_ratio * 50, 25)
      - LEAST(scam_ratio * 80, 40)
    )),
    tier = (
      SELECT t.tier FROM kol_tiers t
      WHERE t.min_followers <= COALESCE((
        SELECT followers FROM twitter_profiles WHERE handle = author_reputation.handle
      ), 0)
      ORDER BY t.min_followers DESC LIMIT 1
    );

  RETURN cnt;
END $$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS author_clusters (
  id INTEGER PRIMARY KEY,
  label TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  avg_rep NUMERIC(5,2),
  top_mints TEXT[],
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS cluster_members (
  cluster_id INTEGER NOT NULL REFERENCES author_clusters(id) ON DELETE CASCADE,
  handle TEXT NOT NULL,
  centrality NUMERIC(6,4),
  joined_at BIGINT NOT NULL,
  PRIMARY KEY (cluster_id, handle)
);
CREATE INDEX IF NOT EXISTS idx_cm_handle ON cluster_members(handle);

CREATE TABLE IF NOT EXISTS author_behavior (
  handle TEXT PRIMARY KEY,
  posts_per_day NUMERIC(8,2),
  active_hours INTEGER[],
  avg_tweet_interval BIGINT,
  burst_ratio NUMERIC(5,4),
  copy_paste_ratio NUMERIC(5,4),
  link_ratio NUMERIC(5,4),
  hashtag_ratio NUMERIC(5,4),
  mention_ratio NUMERIC(5,4),
  emoji_density NUMERIC(6,4),
  caps_ratio NUMERIC(5,4),
  updated_at BIGINT NOT NULL
);

CREATE OR REPLACE FUNCTION rebuild_author_behavior() RETURNS INTEGER AS $$
DECLARE cnt INTEGER;
BEGIN
  INSERT INTO author_behavior (
    handle, posts_per_day, active_hours, avg_tweet_interval,
    burst_ratio, copy_paste_ratio, link_ratio, hashtag_ratio,
    mention_ratio, emoji_density, caps_ratio, updated_at
  )
  WITH base AS (
    SELECT handle, posted_at, text,
      EXTRACT(HOUR FROM to_timestamp(posted_at / 1000))::INT AS hr,
      LAG(posted_at) OVER (PARTITION BY handle ORDER BY posted_at) AS prev_at,
      length(text) AS len,
      length(regexp_replace(text, '[A-Z]', '', 'g')) AS no_caps_len,
      length(regexp_replace(text, '[^\u00A0-\uFFFF]', '', 'g')) AS emoji_len
    FROM twitter_tweets
    WHERE posted_at IS NOT NULL
  )
  SELECT
    handle,
    ROUND(COUNT(*)::NUMERIC / GREATEST(
      EXTRACT(EPOCH FROM (to_timestamp(MAX(posted_at)/1000) - to_timestamp(MIN(posted_at)/1000))) / 86400, 1
    ), 2),
    array_agg(DISTINCT hr) FILTER (WHERE hr IS NOT NULL),
    ROUND(AVG(posted_at - prev_at))::BIGINT,
    ROUND(AVG(CASE WHEN posted_at - prev_at < 3600000 THEN 1 ELSE 0 END), 4),
    ROUND(AVG(CASE WHEN text IN (
      SELECT text FROM twitter_tweets t2 WHERE t2.handle = base.handle GROUP BY text HAVING COUNT(*) > 1
    ) THEN 1 ELSE 0 END), 4),
    ROUND(AVG(CASE WHEN text ~ 'https?://' THEN 1 ELSE 0 END), 4),
    ROUND(AVG(CASE WHEN text ~ '#\w+' THEN 1 ELSE 0 END), 4),
    ROUND(AVG(CASE WHEN text ~ '@\w+' THEN 1 ELSE 0 END), 4),
    ROUND(SUM(emoji_len)::NUMERIC / GREATEST(SUM(len), 1) * 100, 4),
    ROUND(SUM(len - no_caps_len)::NUMERIC / GREATEST(SUM(len), 1), 4),
    (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
  FROM base
  GROUP BY handle
  ON CONFLICT (handle) DO UPDATE SET
    posts_per_day = EXCLUDED.posts_per_day,
    active_hours = EXCLUDED.active_hours,
    avg_tweet_interval = EXCLUDED.avg_tweet_interval,
    burst_ratio = EXCLUDED.burst_ratio,
    copy_paste_ratio = EXCLUDED.copy_paste_ratio,
    link_ratio = EXCLUDED.link_ratio,
    hashtag_ratio = EXCLUDED.hashtag_ratio,
    mention_ratio = EXCLUDED.mention_ratio,
    emoji_density = EXCLUDED.emoji_density,
    caps_ratio = EXCLUDED.caps_ratio,
    updated_at = EXCLUDED.updated_at;

  GET DIAGNOSTICS cnt = ROW_COUNT;
  RETURN cnt;
END $$ LANGUAGE plpgsql;

DROP VIEW IF EXISTS v_suspicious_authors CASCADE;
CREATE VIEW v_suspicious_authors AS
SELECT r.handle, r.reputation_score, r.spam_ratio, r.scam_ratio, r.total_mints,
  b.posts_per_day, b.burst_ratio, b.copy_paste_ratio, b.caps_ratio, b.emoji_density,
  CASE
    WHEN r.reputation_score < 20 THEN 'high_risk'
    WHEN r.reputation_score < 40 THEN 'medium_risk'
    WHEN b.burst_ratio > 0.8 AND b.copy_paste_ratio > 0.5 THEN 'bot_like'
    ELSE 'normal'
  END AS risk_label
FROM author_reputation r
LEFT JOIN author_behavior b ON b.handle = r.handle
WHERE r.reputation_score < 40
   OR (b.burst_ratio > 0.7 AND b.copy_paste_ratio > 0.4)
   OR r.spam_ratio > 0.5
ORDER BY r.reputation_score ASC;

