-- Durable archive attribution survives retention of operational tasks/tweets.
CREATE TABLE IF NOT EXISTS xc_history_posts (
 run_id text NOT NULL REFERENCES xc_history_runs(id) ON DELETE CASCADE,
 tweet_id text NOT NULL,
 snapshot_json jsonb NOT NULL,
 first_observed_at bigint NOT NULL,
 last_observed_at bigint NOT NULL,
 PRIMARY KEY(run_id,tweet_id)
);
