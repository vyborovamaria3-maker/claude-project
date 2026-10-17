-- Explicit raw-response lifecycle and stable author identity.
-- archive_raw_pages.hash is already the SHA-256 response/content key; do not duplicate it.

ALTER TABLE archive_raw_pages
  ADD COLUMN IF NOT EXISTS parser_version TEXT NOT NULL DEFAULT 'unversioned',
  ADD COLUMN IF NOT EXISTS parse_status TEXT NOT NULL DEFAULT 'captured',
  ADD COLUMN IF NOT EXISTS response_status TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'archive_raw_pages_parse_status_check'
      AND conrelid = 'archive_raw_pages'::regclass
  ) THEN
    ALTER TABLE archive_raw_pages
      ADD CONSTRAINT archive_raw_pages_parse_status_check
      CHECK (parse_status IN ('captured','parsed','partial','failed'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'archive_raw_pages_response_status_check'
      AND conrelid = 'archive_raw_pages'::regclass
  ) THEN
    ALTER TABLE archive_raw_pages
      ADD CONSTRAINT archive_raw_pages_response_status_check
      CHECK (response_status IN ('unknown','empty','nonempty','error'));
  END IF;
END $$;

-- Existing raw files are retained for a default 90-day window from capture.
-- Operators can set ARCHIVE_RAW_RETENTION_DAYS for new captures.
UPDATE archive_raw_pages
SET expires_at = received_at + INTERVAL '90 days'
WHERE expires_at IS NULL;

ALTER TABLE archive_raw_pages
  ALTER COLUMN expires_at SET NOT NULL,
  ALTER COLUMN expires_at SET DEFAULT (now() + INTERVAL '90 days');

CREATE INDEX IF NOT EXISTS idx_archive_raw_pages_expiry
  ON archive_raw_pages(expires_at);

ALTER TABLE twitter_tweets
  ADD COLUMN IF NOT EXISTS author_id TEXT;

-- Reuse author IDs already known by the archive layer; never coerce them to JS numbers.
UPDATE twitter_tweets t
SET author_id = p.author_id
FROM archive_posts p
WHERE p.id = t.tweet_id
  AND t.author_id IS NULL
  AND p.author_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_twitter_tweets_author_posted
  ON twitter_tweets(author_id, posted_at DESC)
  WHERE author_id IS NOT NULL;

-- Canonical historical metric view over archive_metrics; no duplicate snapshot table.
CREATE OR REPLACE VIEW v_twitter_tweet_metrics_history AS
SELECT
  m.post_id AS tweet_id,
  m.received_at AS captured_at,
  m.metrics_observed_at AS metric_observed_at,
  m.views,
  m.likes,
  m.reposts AS retweets,
  m.replies,
  m.quotes AS quote_count,
  m.source_id,
  m.raw_hash,
  m.snapshot_key
FROM archive_metrics m;
