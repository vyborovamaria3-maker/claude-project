
CREATE TABLE IF NOT EXISTS tg_sources (
  id BIGSERIAL PRIMARY KEY,
  identifier TEXT NOT NULL UNIQUE,
  peer_id TEXT,
  title TEXT,
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
CREATE UNIQUE INDEX IF NOT EXISTS tg_jobs_one_open_job_idx ON tg_jobs (source_id)
  WHERE state IN ('pending','running','delayed');
CREATE INDEX IF NOT EXISTS tg_jobs_claim_idx ON tg_jobs (run_at, id)
  WHERE state IN ('pending','running','delayed');
