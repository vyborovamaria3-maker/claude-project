-- Additive source transactional outbox, PostgreSQL 16.
-- TG native migration runner computes checksum of this exact immutable SQL.
-- Turn on TG_INTELLIGENCE_OUTBOX_ENABLED only after installing Intelligence consumer.
CREATE TABLE IF NOT EXISTS outbox_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_system TEXT NOT NULL CHECK (source_system = 'tg'),
  event_kind TEXT NOT NULL,
  event_key TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  lease_owner TEXT,
  lease_until TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INT NOT NULL DEFAULT 0,
  dead_lettered_at TIMESTAMPTZ,
  last_error TEXT,
  UNIQUE (source_system,event_kind,event_key)
);
CREATE INDEX IF NOT EXISTS tg_outbox_pending_idx ON outbox_events(next_attempt_at,id)
  WHERE processed_at IS NULL AND dead_lettered_at IS NULL;
