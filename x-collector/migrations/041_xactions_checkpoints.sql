-- HTTP GraphQL cursor is opaque and is never stored in historical max_id columns.
-- The caller must commit the page's posts and this cursor in one transaction.
CREATE TABLE IF NOT EXISTS xc_http_checkpoints (
  task_id bigint NOT NULL REFERENCES x_tasks(id) ON DELETE CASCADE,
  source_kind text NOT NULL CHECK (source_kind IN ('timeline', 'list', 'members', 'search')),
  source_key text NOT NULL CHECK (length(source_key) BETWEEN 1 AND 500),
  query_fingerprint text NOT NULL CHECK (query_fingerprint ~ '^[0-9a-f]{64}$'),
  cursor text CHECK (cursor IS NULL OR length(cursor) <= 8192),
  completed boolean NOT NULL DEFAULT false,
  pages_committed integer NOT NULL DEFAULT 0 CHECK (pages_committed >= 0),
  items_committed bigint NOT NULL DEFAULT 0 CHECK (items_committed >= 0),
  updated_at bigint NOT NULL,
  PRIMARY KEY (task_id, source_kind, source_key),
  CHECK (NOT completed OR cursor IS NULL)
);
CREATE INDEX IF NOT EXISTS xc_http_checkpoints_active_idx
  ON xc_http_checkpoints (updated_at) WHERE NOT completed;
