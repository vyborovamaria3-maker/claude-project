DO $$ BEGIN CREATE EXTENSION IF NOT EXISTS pg_trgm; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pg_trgm skip: %', SQLERRM; END $$;

CREATE TABLE IF NOT EXISTS x_accounts (
  name TEXT PRIMARY KEY,
  session_encrypted BYTEA NOT NULL,
  tier TEXT NOT NULL DEFAULT 'new' CHECK (tier IN ('new','warm','hot','retired')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cooldown','captcha','banned')),
  weight_quota_per_hour INTEGER NOT NULL DEFAULT 15,
  weight_used_this_hour INTEGER NOT NULL DEFAULT 0,
  hour_window_start BIGINT NOT NULL,
  total_requests BIGINT NOT NULL DEFAULT 0,
  total_errors BIGINT NOT NULL DEFAULT 0,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  last_success_at BIGINT,
  last_error_at BIGINT,
  cooldown_until BIGINT NOT NULL DEFAULT 0,
  account_busy_until BIGINT NOT NULL DEFAULT 0,
  proxy_json TEXT,
  user_agent TEXT,
  timezone TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_x_accounts_pickable ON x_accounts(status, tier, cooldown_until) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS x_workers (
  id TEXT PRIMARY KEY,
  pid INTEGER,
  host TEXT,
  started_at BIGINT NOT NULL,
  last_heartbeat BIGINT NOT NULL,
  tasks_done BIGINT NOT NULL DEFAULT 0,
  tasks_failed BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','stopped','dead'))
);
CREATE INDEX IF NOT EXISTS idx_x_workers_hb ON x_workers(last_heartbeat DESC) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS x_tasks (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('search','timeline','profile')),
  payload_json JSONB NOT NULL,
  mint TEXT,
  handle TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  available_at BIGINT NOT NULL,
  claimed_by TEXT,
  claimed_at BIGINT,
  lease_expires_at BIGINT,
  last_error TEXT,
  idempotency_key TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_x_tasks_idem ON x_tasks(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_x_tasks_claim ON x_tasks(status, available_at, priority DESC) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_x_tasks_lease ON x_tasks(lease_expires_at) WHERE status = 'claimed';

CREATE TABLE IF NOT EXISTS x_tasks_dlq (
  id BIGSERIAL PRIMARY KEY,
  original_id BIGINT NOT NULL,
  kind TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  mint TEXT,
  handle TEXT,
  attempts INTEGER NOT NULL,
  last_error TEXT NOT NULL,
  failed_at BIGINT NOT NULL,
  reviewed_at BIGINT,
  review_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_dlq_unreviewed ON x_tasks_dlq(failed_at DESC) WHERE reviewed_at IS NULL;

CREATE TABLE IF NOT EXISTS twitter_tweets (
  tweet_id TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  text TEXT NOT NULL,
  url TEXT,
  views BIGINT NOT NULL DEFAULT 0,
  likes BIGINT NOT NULL DEFAULT 0,
  retweets BIGINT NOT NULL DEFAULT 0,
  replies BIGINT NOT NULL DEFAULT 0,
  is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  posted_at BIGINT,
  first_seen_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  source_query TEXT
);
CREATE INDEX IF NOT EXISTS idx_tweets_handle ON twitter_tweets(handle, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_tweets_posted ON twitter_tweets(posted_at DESC);

CREATE TABLE IF NOT EXISTS tweet_token_links (
  tweet_id TEXT NOT NULL REFERENCES twitter_tweets(tweet_id) ON DELETE CASCADE,
  mint TEXT NOT NULL,
  handle TEXT NOT NULL,
  linked_at BIGINT NOT NULL,
  PRIMARY KEY (tweet_id, mint)
);
CREATE INDEX IF NOT EXISTS idx_ttl_mint ON tweet_token_links(mint, linked_at DESC);
CREATE INDEX IF NOT EXISTS idx_ttl_handle ON tweet_token_links(handle);

CREATE TABLE IF NOT EXISTS twitter_profiles (
  handle TEXT PRIMARY KEY,
  display_name TEXT,
  bio TEXT,
  followers BIGINT,
  following BIGINT,
  posts_count BIGINT,
  is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  joined_at BIGINT,
  avatar_url TEXT,
  first_seen_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profiles_followers ON twitter_profiles(followers DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS author_token_stats (
  handle TEXT NOT NULL,
  mint TEXT NOT NULL,
  tweets_count INTEGER NOT NULL DEFAULT 0,
  total_views BIGINT NOT NULL DEFAULT 0,
  total_likes BIGINT NOT NULL DEFAULT 0,
  total_retweets BIGINT NOT NULL DEFAULT 0,
  avg_views NUMERIC(14,2),
  avg_likes NUMERIC(14,2),
  first_tweeted_at BIGINT,
  last_tweeted_at BIGINT,
  is_verified BOOLEAN DEFAULT FALSE,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (handle, mint)
);
CREATE INDEX IF NOT EXISTS idx_ats_mint_views ON author_token_stats(mint, total_views DESC);
CREATE INDEX IF NOT EXISTS idx_ats_handle ON author_token_stats(handle);

CREATE TABLE IF NOT EXISTS author_cooccurrence (
  handle_a TEXT NOT NULL,
  handle_b TEXT NOT NULL,
  shared_mints INTEGER NOT NULL,
  last_seen BIGINT NOT NULL,
  PRIMARY KEY (handle_a, handle_b)
);
CREATE INDEX IF NOT EXISTS idx_cooc_shared ON author_cooccurrence(shared_mints DESC);

CREATE TABLE IF NOT EXISTS scrape_runs (
  id BIGSERIAL PRIMARY KEY,
  started_at BIGINT NOT NULL,
  finished_at BIGINT,
  mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed','aborted')),
  mints_total INTEGER NOT NULL DEFAULT 0,
  mints_done INTEGER NOT NULL DEFAULT 0,
  accounts_found INTEGER NOT NULL DEFAULT 0,
  tweets_found BIGINT NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  worker_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_started ON scrape_runs(started_at DESC);

