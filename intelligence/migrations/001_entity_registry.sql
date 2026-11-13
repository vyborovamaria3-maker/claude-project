-- Apply only to an isolated Intelligence PostgreSQL database.
CREATE TABLE IF NOT EXISTS intelligence_inbox (
  source_system TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  event_key TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  evidence_source_id TEXT NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_system, event_kind, event_key)
);
CREATE TABLE IF NOT EXISTS entity_registry (
  kind TEXT NOT NULL CHECK (kind IN ('token','wallet','author','source')),
  canonical_id TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (kind, canonical_id),
  CHECK (first_seen_at <= last_seen_at)
);
CREATE TABLE IF NOT EXISTS entity_evidence (
  source_system TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  event_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  canonical_id TEXT NOT NULL,
  evidence_source_id TEXT NOT NULL,
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('x_tweet','tg_message','chain_tx')),
  observed_at TIMESTAMPTZ NOT NULL,
  occurred_at TIMESTAMPTZ,
  parser_version TEXT,
  PRIMARY KEY (source_system,event_kind,event_key,kind,canonical_id,evidence_source_id),
  FOREIGN KEY (source_system,event_kind,event_key)
    REFERENCES intelligence_inbox(source_system,event_kind,event_key),
  FOREIGN KEY (kind,canonical_id) REFERENCES entity_registry(kind,canonical_id)
);
CREATE INDEX IF NOT EXISTS idx_entity_evidence_recent
  ON entity_evidence(kind,canonical_id,observed_at DESC);
