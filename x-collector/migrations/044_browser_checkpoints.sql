-- Browser pages have no trustworthy opaque X cursor. Keep durable, lease-fenced
-- evidence of saved posts; a numeric max_id is a best-effort search continuation
-- only, never proof that the X feed has been exhausted.
CREATE TABLE IF NOT EXISTS xc_browser_checkpoints (
 task_id bigint PRIMARY KEY REFERENCES x_tasks(id) ON DELETE CASCADE,
 query_fingerprint text NOT NULL CHECK(query_fingerprint ~ '^[0-9a-f]{64}$'),
 observed_count bigint NOT NULL DEFAULT 0 CHECK(observed_count>=0),
 oldest_id text,
 newest_id text,
 coverage text NOT NULL DEFAULT 'partial'
   CHECK(coverage IN ('partial','unverified','target_reached')),
 updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS xc_browser_checkpoints_updated_idx
 ON xc_browser_checkpoints(updated_at);
