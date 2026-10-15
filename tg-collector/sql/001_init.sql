
CREATE TABLE IF NOT EXISTS tg_sources (
  id BIGSERIAL PRIMARY KEY,
  identifier TEXT NOT NULL UNIQUE,
  peer_id TEXT,
  title TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_message_id BIGINT NOT NULL DEFAULT 0,
  history_partial BOOLEAN NOT NULL DEFAULT FALSE,
  last_success_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tg_messages (
  source_id BIGINT NOT NULL REFERENCES tg_sources(id) ON DELETE CASCADE,
  message_id BIGINT NOT NULL,
  sender_id TEXT,
  posted_at TIMESTAMPTZ,
  text TEXT NOT NULL DEFAULT '',
  views INTEGER,
  forwards INTEGER,
  replies INTEGER,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, message_id)
);
ALTER TABLE tg_sources ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;
CREATE INDEX IF NOT EXISTS tg_messages_posted_at_idx ON tg_messages (source_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS tg_messages_sender_id_idx ON tg_messages (sender_id);
CREATE TABLE IF NOT EXISTS tg_jobs (
  id BIGSERIAL PRIMARY KEY,
  source_id BIGINT NOT NULL REFERENCES tg_sources(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','delayed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  base_message_id BIGINT,
  high_message_id BIGINT,
  cursor_before_id BIGINT,
  scanned_count INTEGER NOT NULL DEFAULT 0,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One logical sync cursor per source; do not create a second job after failure.
DROP INDEX IF EXISTS tg_jobs_one_open_job_idx;
CREATE UNIQUE INDEX IF NOT EXISTS tg_jobs_source_unique_idx ON tg_jobs (source_id);
CREATE INDEX IF NOT EXISTS tg_jobs_claim_idx ON tg_jobs (run_at, id)
  WHERE state IN ('pending','running','delayed');

CREATE TABLE IF NOT EXISTS tg_runtime (
  id INTEGER PRIMARY KEY CHECK (id=1),
  pause_until TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  worker_started_at TIMESTAMPTZ
);
ALTER TABLE tg_runtime ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;
ALTER TABLE tg_runtime ADD COLUMN IF NOT EXISTS worker_started_at TIMESTAMPTZ;
INSERT INTO tg_runtime(id) VALUES(1) ON CONFLICT(id) DO NOTHING;
