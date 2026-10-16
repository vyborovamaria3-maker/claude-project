-- Confidence-aware links between tweets and known Solana token mints.
-- Existing task-context links remain intact and start as probable, not confirmed.
ALTER TABLE tweet_token_links
  ADD COLUMN IF NOT EXISTS match_method TEXT NOT NULL DEFAULT 'task_context',
  ADD COLUMN IF NOT EXISTS match_level TEXT NOT NULL DEFAULT 'probable'
    CHECK (match_level IN ('exact','confirmed','probable','uncertain')),
  ADD COLUMN IF NOT EXISTS confidence DOUBLE PRECISION NOT NULL DEFAULT 0.65
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