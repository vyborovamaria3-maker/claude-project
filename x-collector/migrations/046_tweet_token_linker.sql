-- Confidence-aware links between tweets and known Solana token mints.
-- Existing task-context links remain intact and start as probable, not confirmed. Confidence is a heuristic score, not a calibrated probability.
ALTER TABLE tweet_token_links
  ADD COLUMN IF NOT EXISTS match_method TEXT NOT NULL DEFAULT 'task_context',
  ADD COLUMN IF NOT EXISTS match_level TEXT NOT NULL DEFAULT 'probable'
    CHECK (match_level IN ('exact','confirmed','probable','uncertain')),
  ADD COLUMN IF NOT EXISTS confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5
    CHECK (confidence BETWEEN 0 AND 1),
  ADD COLUMN IF NOT EXISTS evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS linker_version TEXT;

CREATE INDEX IF NOT EXISTS idx_ttl_confidence
  ON tweet_token_links(mint, confidence DESC, linked_at DESC);

CREATE TABLE IF NOT EXISTS tweet_token_linker_state (
  tweet_id TEXT NOT NULL REFERENCES twitter_tweets(tweet_id) ON DELETE CASCADE,
  linker_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('done','failed')),
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  error TEXT,
  PRIMARY KEY (tweet_id, linker_version)
);
CREATE INDEX IF NOT EXISTS idx_tweet_token_linker_state_version
  ON tweet_token_linker_state(linker_version, status, processed_at);

-- Keep author-lead analytics compatible with the real PostgreSQL type returned by AVG(double precision).
-- This summary consumes tweet_token_links, including links created by the token linker above.
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
    ROUND(AVG(lead_minutes_from_median)::NUMERIC, 2),
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
