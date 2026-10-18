-- Source-backed timeline: future data must not appear in as-of queries.
CREATE TABLE IF NOT EXISTS timeline_events (
  source_system TEXT NOT NULL,
  source_event_kind TEXT NOT NULL,
  event_key TEXT NOT NULL,
  timeline_kind TEXT NOT NULL CHECK (timeline_kind IN (
    'tweet_published','tg_message_published','chain_transaction',
    'trade_executed','signal_detected','signal_outcome'
  )),
  occurred_at TIMESTAMPTZ NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  evidence_source_id TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  payload JSONB NOT NULL,
  PRIMARY KEY (source_system,source_event_kind,event_key),
  FOREIGN KEY (source_system,source_event_kind,event_key)
    REFERENCES intelligence_inbox(source_system,event_kind,event_key)
);
CREATE TABLE IF NOT EXISTS timeline_event_entities (
  source_system TEXT NOT NULL,
  source_event_kind TEXT NOT NULL,
  event_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  canonical_id TEXT NOT NULL,
  PRIMARY KEY (source_system,source_event_kind,event_key,kind,canonical_id),
  FOREIGN KEY (source_system,source_event_kind,event_key)
    REFERENCES timeline_events(source_system,source_event_kind,event_key),
  FOREIGN KEY (kind,canonical_id) REFERENCES entity_registry(kind,canonical_id)
);
CREATE INDEX IF NOT EXISTS idx_timeline_by_entity
  ON timeline_event_entities(kind,canonical_id,source_system,event_key);
CREATE INDEX IF NOT EXISTS idx_timeline_by_time
  ON timeline_events(occurred_at DESC,observed_at DESC);
