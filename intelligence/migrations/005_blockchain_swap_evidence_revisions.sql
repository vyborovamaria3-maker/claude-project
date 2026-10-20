-- ARCH-06b: versioned, immutable blockchain evidence state; not a trade tape.
-- Apply ONLY after 001_entity_registry.sql, in a reviewed isolated DB first.
CREATE TABLE IF NOT EXISTS blockchain_swap_evidence_revisions (
  source_system TEXT NOT NULL CHECK (source_system='blockchain'),
  event_kind TEXT NOT NULL CHECK (event_kind='token_swap_evidence_revision'),
  event_key TEXT NOT NULL,
  wallet_id TEXT NOT NULL,
  signature TEXT NOT NULL,
  raw_revision BIGINT NOT NULL CHECK (raw_revision>0),
  raw_sha256 TEXT NOT NULL CHECK (raw_sha256 ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('supported','unsupported')),
  canonical_token_id TEXT,
  slot BIGINT,
  observed_at TIMESTAMPTZ NOT NULL,
  occurred_at TIMESTAMPTZ,
  details JSONB NOT NULL CHECK(jsonb_typeof(details)='object'),
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(source_system,event_kind,event_key),
  UNIQUE(wallet_id,signature,raw_revision),
  FOREIGN KEY(source_system,event_kind,event_key)
    REFERENCES intelligence_inbox(source_system,event_kind,event_key),
  CHECK (
    (state='supported' AND canonical_token_id IS NOT NULL AND slot>0 AND occurred_at IS NOT NULL)
    OR (state='unsupported' AND canonical_token_id IS NULL AND slot IS NULL AND occurred_at IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_blockchain_swap_revision_current
  ON blockchain_swap_evidence_revisions(wallet_id,signature,raw_revision DESC);
CREATE INDEX IF NOT EXISTS idx_blockchain_swap_revision_token
  ON blockchain_swap_evidence_revisions(canonical_token_id,observed_at DESC)
  WHERE state='supported';
