-- Public archive: preserve provenance, unknown metrics and observation time.
CREATE TABLE IF NOT EXISTS archive_sources (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, license TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('x','tweets','tokens')), metadata JSONB NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS archive_posts (
 id TEXT PRIMARY KEY, author_id TEXT, author_handle TEXT, conversation_id TEXT, text TEXT NOT NULL,
 posted_at TIMESTAMPTZ NOT NULL, lang TEXT, first_received_at TIMESTAMPTZ NOT NULL,
 last_received_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS archive_posts_time ON archive_posts(posted_at,id);
CREATE INDEX IF NOT EXISTS archive_posts_author ON archive_posts(author_id,posted_at);
CREATE INDEX IF NOT EXISTS archive_posts_conversation ON archive_posts(conversation_id,posted_at);
CREATE TABLE IF NOT EXISTS archive_users (
 id TEXT PRIMARY KEY, username TEXT, profile JSONB NOT NULL, received_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS archive_metrics (
 post_id TEXT NOT NULL REFERENCES archive_posts ON DELETE CASCADE,
 source_id TEXT NOT NULL REFERENCES archive_sources,
 received_at TIMESTAMPTZ NOT NULL, metrics_observed_at TIMESTAMPTZ,
 likes BIGINT, views BIGINT, reposts BIGINT, replies BIGINT, quotes BIGINT,
 raw_hash TEXT NOT NULL, snapshot_key TEXT NOT NULL,
 PRIMARY KEY(post_id,source_id,snapshot_key)
);
CREATE INDEX IF NOT EXISTS archive_metrics_time ON archive_metrics(post_id,metrics_observed_at DESC);
CREATE TABLE IF NOT EXISTS archive_edges (
 post_id TEXT NOT NULL REFERENCES archive_posts ON DELETE CASCADE,
 target_id TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY(post_id,target_id,kind)
);
CREATE INDEX IF NOT EXISTS archive_edges_target ON archive_edges(target_id,kind);
CREATE TABLE IF NOT EXISTS archive_token_links (
 post_id TEXT NOT NULL REFERENCES archive_posts ON DELETE CASCADE, mint TEXT NOT NULL,
 method TEXT NOT NULL DEFAULT 'address_literal', PRIMARY KEY(post_id,mint)
);
CREATE INDEX IF NOT EXISTS archive_links_mint ON archive_token_links(mint,post_id);
CREATE TABLE IF NOT EXISTS archive_tokens (
 mint TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES archive_sources,
 created_at TIMESTAMPTZ, graduated_at TIMESTAMPTZ, symbol TEXT, name TEXT, twitter_url TEXT,
 raw JSONB NOT NULL, PRIMARY KEY(mint,source_id)
);
CREATE TABLE IF NOT EXISTS archive_token_records (
 mint TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES archive_sources, record_hash TEXT NOT NULL,
 captured_at TIMESTAMPTZ, features JSONB NOT NULL, labels JSONB NOT NULL,
 raw JSONB NOT NULL, PRIMARY KEY(mint,source_id,record_hash)
);
CREATE INDEX IF NOT EXISTS archive_token_records_time ON archive_token_records(mint,captured_at);
CREATE TABLE IF NOT EXISTS archive_price_samples (
 mint TEXT NOT NULL, source_id TEXT NOT NULL, record_hash TEXT NOT NULL, minute_index INTEGER NOT NULL CHECK(minute_index BETWEEN 0 AND 14),
 price DOUBLE PRECISION, trades BIGINT,
 PRIMARY KEY(mint,source_id,record_hash,minute_index),
 FOREIGN KEY(mint,source_id,record_hash) REFERENCES archive_token_records ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS archive_raw_pages (
 hash TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES archive_sources,
 path TEXT NOT NULL, received_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(hash,source_id)
);
CREATE TABLE IF NOT EXISTS archive_jobs (
 id BIGSERIAL PRIMARY KEY, source_id TEXT NOT NULL REFERENCES archive_sources, query TEXT NOT NULL,
 start_at TIMESTAMPTZ NOT NULL, end_at TIMESTAMPTZ NOT NULL CHECK(end_at>start_at),
 next_token TEXT, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','done','partial','paused','failed')),
 pages BIGINT NOT NULL DEFAULT 0, posts_seen BIGINT NOT NULL DEFAULT 0, partial_errors BIGINT NOT NULL DEFAULT 0,
 next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_error TEXT,
 UNIQUE(source_id,query,start_at,end_at)
);
CREATE INDEX IF NOT EXISTS archive_jobs_pending ON archive_jobs(next_attempt_at,start_at,id) WHERE state='pending';
CREATE TABLE IF NOT EXISTS archive_imports (
 source_id TEXT NOT NULL REFERENCES archive_sources, file_hash TEXT NOT NULL, format TEXT NOT NULL,
 next_line BIGINT NOT NULL DEFAULT 0, done BOOLEAN NOT NULL DEFAULT false,
 PRIMARY KEY(source_id,file_hash,format)
);
-- A relation is evidence of a shared literal address, not proof of a shared owner.
CREATE OR REPLACE VIEW archive_author_connections AS
 SELECT a.author_id author_a,b.author_id author_b,COUNT(DISTINCT la.mint)::int shared_mints
 FROM archive_token_links la JOIN archive_posts a ON a.id=la.post_id
 JOIN archive_token_links lb ON lb.mint=la.mint JOIN archive_posts b ON b.id=lb.post_id
 WHERE a.author_id<b.author_id AND EXISTS(SELECT 1 FROM archive_tokens t WHERE t.mint=la.mint)
 GROUP BY a.author_id,b.author_id;

CREATE TABLE IF NOT EXISTS archive_legacy_cursor (
 source_id TEXT PRIMARY KEY REFERENCES archive_sources, last_time BIGINT NOT NULL DEFAULT 0,
 last_id TEXT NOT NULL DEFAULT ''
);
DO $$ BEGIN
 IF to_regclass('twitter_tweets') IS NOT NULL THEN
  CREATE INDEX IF NOT EXISTS idx_tweets_archive_bridge ON twitter_tweets(updated_at,tweet_id);
 END IF;
END $$;
