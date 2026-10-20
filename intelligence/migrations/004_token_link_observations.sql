-- ARCH-07a, additive only. Apply after 001_entity_registry.sql.
-- Immutable evidence events, NOT mutable legacy source records.
CREATE TABLE IF NOT EXISTS token_link_observations (
  source_system TEXT NOT NULL CHECK (source_system IN ('x','tg')),
  event_kind TEXT NOT NULL CHECK (event_kind IN ('token_link_verified','token_links_invalidated')),
  event_key TEXT NOT NULL,
  evidence_source_id TEXT NOT NULL,
  canonical_token_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('verified','invalidated')),
  observed_at TIMESTAMPTZ NOT NULL,
  occurred_at TIMESTAMPTZ,
  source_revision_sha256 TEXT NOT NULL CHECK (source_revision_sha256 ~ '^[a-f0-9]{64}$'),
  details JSONB NOT NULL CHECK (jsonb_typeof(details)='object'),
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_system,event_kind,event_key),
  FOREIGN KEY (source_system,event_kind,event_key)
    REFERENCES intelligence_inbox(source_system,event_kind,event_key),
  CHECK (
    (state='verified' AND event_kind='token_link_verified' AND canonical_token_id IS NOT NULL) OR
    (state='invalidated' AND event_kind='token_links_invalidated' AND canonical_token_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_token_link_active_lookup
  ON token_link_observations(canonical_token_id,observed_at DESC)
  WHERE state='verified';
CREATE INDEX IF NOT EXISTS idx_token_link_evidence_history
  ON token_link_observations(source_system,evidence_source_id,observed_at DESC);
