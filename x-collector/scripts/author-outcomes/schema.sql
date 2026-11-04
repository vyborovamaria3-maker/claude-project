-- Isolated, additive author mention evaluation. Never changes collection cursors.
CREATE TABLE IF NOT EXISTS xc_author_eval_state (
 id boolean PRIMARY KEY DEFAULT true CHECK(id), cursor_at bigint NOT NULL DEFAULT 0,
 cursor_id text NOT NULL DEFAULT '', scanned bigint NOT NULL DEFAULT 0,
 last_scan_at bigint, last_price_at bigint, last_error text, scan_caught_up boolean NOT NULL DEFAULT false
);
INSERT INTO xc_author_eval_state(id) VALUES(true) ON CONFLICT DO NOTHING;
CREATE INDEX IF NOT EXISTS idx_tweets_author_eval_updated ON twitter_tweets(updated_at,tweet_id);
CREATE TABLE IF NOT EXISTS xc_author_mint_candidates (
 tweet_id text NOT NULL REFERENCES twitter_tweets(tweet_id) ON DELETE CASCADE,mint text NOT NULL,
 author text NOT NULL,posted_at bigint NOT NULL,source_text text NOT NULL,source_hash text NOT NULL,
 first_seen_at bigint NOT NULL,discovered_at bigint NOT NULL,url text,active boolean NOT NULL DEFAULT true,
 legacy_link_owned boolean NOT NULL DEFAULT false,next_price_at bigint NOT NULL DEFAULT 0,
 last_price_status text NOT NULL DEFAULT 'pending', PRIMARY KEY(tweet_id,mint)
);
CREATE INDEX IF NOT EXISTS idx_author_candidate_first ON xc_author_mint_candidates(author,mint,posted_at,tweet_id) WHERE active;
CREATE INDEX IF NOT EXISTS idx_author_candidate_due ON xc_author_mint_candidates(next_price_at,posted_at) WHERE active;
CREATE TABLE IF NOT EXISTS xc_author_mint_registry (
 mint text PRIMARY KEY,status text NOT NULL,checked_at bigint NOT NULL,retry_at bigint NOT NULL,
 proof jsonb,last_error text
);
CREATE TABLE IF NOT EXISTS xc_author_price_evidence (
 evidence_hash text PRIMARY KEY,mint text NOT NULL,pool text NOT NULL,fetched_at bigint NOT NULL,
 first_at bigint,last_at bigint,proof jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_author_price_mint ON xc_author_price_evidence(mint,first_at,last_at);
CREATE TABLE IF NOT EXISTS xc_author_post_outcomes (
 tweet_id text NOT NULL,mint text NOT NULL,horizon_hours integer NOT NULL CHECK(horizon_hours IN(1,24,72)),
 source_hash text NOT NULL,entry_at bigint NOT NULL,exit_at bigint NOT NULL,
 entry_usd double precision NOT NULL CHECK(entry_usd>0),exit_usd double precision NOT NULL CHECK(exit_usd>0),
 gross_return double precision NOT NULL,net_return double precision NOT NULL,
 evidence_hash text NOT NULL REFERENCES xc_author_price_evidence(evidence_hash),
 evaluated_at bigint NOT NULL,mode text NOT NULL CHECK(mode IN('retrospective','prospective')),
 PRIMARY KEY(tweet_id,mint,horizon_hours), FOREIGN KEY(tweet_id,mint) REFERENCES xc_author_mint_candidates(tweet_id,mint) ON DELETE CASCADE
);

ALTER TABLE xc_author_post_outcomes DROP CONSTRAINT IF EXISTS xc_author_post_outcomes_tweet_id_mint_fkey;
ALTER TABLE xc_author_post_outcomes ADD CONSTRAINT xc_author_post_outcomes_tweet_id_mint_fkey FOREIGN KEY(tweet_id,mint) REFERENCES xc_author_mint_candidates(tweet_id,mint) ON DELETE CASCADE;

ALTER TABLE xc_author_eval_state ADD COLUMN IF NOT EXISTS price_backoff_until bigint NOT NULL DEFAULT 0;
