/** Apply through a NEW source-specific migration, never by replacing legacy applied SQL. */
export const POSTGRES_OUTBOX_DDL = `CREATE TABLE IF NOT EXISTS outbox_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_system TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  event_key TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  lease_owner TEXT,
  lease_until TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts INT NOT NULL DEFAULT 0,
  dead_lettered_at TIMESTAMPTZ,
  last_error TEXT,
  UNIQUE (source_system, event_kind, event_key)
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox_events(next_attempt_at,id)
WHERE processed_at IS NULL AND dead_lettered_at IS NULL;`;

export const SQLITE_OUTBOX_DDL = `CREATE TABLE IF NOT EXISTS outbox_events (
  id INTEGER PRIMARY KEY,
  source_system TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  event_key TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  processed_at TEXT,
  lease_owner TEXT,
  lease_until TEXT,
  next_attempt_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  dead_lettered_at TEXT,
  last_error TEXT,
  UNIQUE (source_system, event_kind, event_key)
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox_events(next_attempt_at,id)
WHERE processed_at IS NULL AND dead_lettered_at IS NULL;`;
