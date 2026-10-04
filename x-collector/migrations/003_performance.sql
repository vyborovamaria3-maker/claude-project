-- Reconstructed migration for the integrated x-collector source snapshot.
-- The supplied archive did not contain the original 003 file. These additive
-- indexes are based on the surviving retention and dashboard query patterns;
-- this is not a byte-for-byte recovery of the missing upstream migration.

-- The retention worker filters tweets by first_seen_at, and the dashboard
-- shows newly collected tweets in that order.
CREATE INDEX IF NOT EXISTS idx_tweets_first_seen
  ON twitter_tweets(first_seen_at DESC);

-- Retention deletes old links by linked_at. Existing mint-leading indexes
-- cannot serve this range scan when the mint is not constrained.
CREATE INDEX IF NOT EXISTS idx_ttl_linked_at
  ON tweet_token_links(linked_at);

-- Retention only removes terminal tasks; keep the index small by excluding
-- queued and in-flight work.
CREATE INDEX IF NOT EXISTS idx_x_tasks_terminal_created
  ON x_tasks(created_at)
  WHERE status IN ('done', 'failed');

-- Recent completed scrape runs are shown and old completed runs are pruned.
CREATE INDEX IF NOT EXISTS idx_runs_terminal_started
  ON scrape_runs(started_at DESC)
  WHERE status IN ('done', 'failed', 'aborted');
