-- X Collector: opt-in event source outbox (never replace the pre-existing
-- publishing/reply workflows). Applied by the explicit ordered X migration
-- manifest after 049_raw_retention_author_id.sql.
CREATE TABLE IF NOT EXISTS outbox_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_system TEXT NOT NULL CHECK (source_system='x'),
  event_kind TEXT NOT NULL,
  event_key TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  lease_owner TEXT,
  lease_until TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INTEGER NOT NULL DEFAULT 0,
  dead_lettered_at TIMESTAMPTZ,
  last_error TEXT,
  UNIQUE(source_system,event_kind,event_key)
);
CREATE INDEX IF NOT EXISTS idx_x_intelligence_outbox_pending ON outbox_events(next_attempt_at,id)
  WHERE processed_at IS NULL AND dead_lettered_at IS NULL;
