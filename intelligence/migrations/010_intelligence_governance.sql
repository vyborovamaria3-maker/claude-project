-- Intelligence 2.2 governance: additive, destination-only. Apply AFTER 001-006, 008 and 009.
-- Existing intelligence_inbox already provides (source_system,event_kind,event_key) idempotency.
-- Never run this DDL in an X, Telegram or blockchain source database.

-- Explicit time at which a computed value was actually available to a consumer.
-- Generated values prevent callers from backdating historical backfills.
ALTER TABLE chain_token_features ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ
  GENERATED ALWAYS AS (GREATEST(as_of,computed_at)) STORED;
CREATE INDEX IF NOT EXISTS idx_chain_features_available ON chain_token_features
  (canonical_token_id,feature_version,available_at DESC);
ALTER TABLE token_daily_cross_platform ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ
  GENERATED ALWAYS AS (GREATEST(as_of,created_at)) STORED;
CREATE INDEX IF NOT EXISTS idx_cross_platform_available ON token_daily_cross_platform
  (canonical_token_id,available_at DESC);
ALTER TABLE token_alerts ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ
  GENERATED ALWAYS AS (GREATEST(triggered_at,created_at)) STORED;
CREATE INDEX IF NOT EXISTS idx_alerts_available ON token_alerts(available_at DESC);

-- All current scores are HEURISTICS, not calibrated likelihoods of market events.
ALTER TABLE token_daily_cross_platform ADD COLUMN IF NOT EXISTS score_interpretation JSONB NOT NULL
  DEFAULT '{"attention":"heuristic","credibility":"heuristic","risk":"heuristic","momentum":"heuristic"}'::jsonb
  CHECK (jsonb_typeof(score_interpretation)='object');

-- Verified mappings are evidence-backed, versioned and never inferred from mutable handles.
CREATE TABLE IF NOT EXISTS entity_external_mappings (
  source_system TEXT NOT NULL CHECK (source_system IN ('x','tg','blockchain')),
  entity_kind TEXT NOT NULL,
  external_id TEXT NOT NULL CHECK(length(external_id) BETWEEN 1 AND 256),
  canonical_id TEXT NOT NULL,
  evidence_source_id TEXT NOT NULL CHECK(length(evidence_source_id) BETWEEN 1 AND 256),
  verified_at TIMESTAMPTZ NOT NULL,
  valid_from TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ,
  method TEXT NOT NULL CHECK(method IN ('verified_mint_account','source_stable_id','cryptographic_attestation')),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(source_system,entity_kind,external_id,canonical_id,verified_at),
  FOREIGN KEY(entity_kind,canonical_id) REFERENCES entity_registry(kind,canonical_id),
  CHECK (valid_until IS NULL OR valid_until>valid_from)
);
CREATE INDEX IF NOT EXISTS idx_mapping_canonical ON entity_external_mappings(entity_kind,canonical_id,verified_at DESC);

-- Granular coverage is an additional attestation, not a replacement for source_coverage_windows.
CREATE TABLE IF NOT EXISTS analytics_coverage_assessments (
  assessment_id BIGSERIAL PRIMARY KEY,
  source_system TEXT NOT NULL CHECK(source_system IN ('x','tg','blockchain','derived')),
  coverage_kind TEXT NOT NULL CHECK(coverage_kind IN ('collection','identification','computation','outcome')),
  entity_kind TEXT NOT NULL CHECK(entity_kind IN ('source','token','wallet')),
  entity_key TEXT NOT NULL CHECK(length(entity_key) BETWEEN 1 AND 256),
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  known_at TIMESTAMPTZ NOT NULL,
  expected_count BIGINT CHECK(expected_count IS NULL OR expected_count>=0),
  actual_count BIGINT NOT NULL CHECK(actual_count>=0),
  verification_method TEXT,
  evidence_ref TEXT,
  status TEXT NOT NULL CHECK(status IN ('complete','partial','unknown')),
  reason TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(source_system,coverage_kind,entity_kind,entity_key,window_start,window_end,known_at),
  CHECK(window_end>window_start),
  CHECK(status<>'complete' OR
    (known_at>=window_end AND expected_count IS NOT NULL AND expected_count=actual_count
      AND verification_method IS NOT NULL AND length(verification_method)>0
      AND evidence_ref IS NOT NULL AND length(evidence_ref)>0))
);
CREATE INDEX IF NOT EXISTS idx_analytics_coverage_partial ON analytics_coverage_assessments
 (coverage_kind,status,window_end DESC);

-- No plaintext message body is stored here. Payload is ciphertext with an EXTERNAL key.
-- The encryption/decryption adapter is intentionally NOT wired without a secret/retention policy.
CREATE TABLE IF NOT EXISTS event_text_snapshots (
  source_system TEXT NOT NULL CHECK(source_system IN ('x','tg')),
  source_event_kind TEXT NOT NULL,
  event_key TEXT NOT NULL,
  revision_sha256 TEXT NOT NULL CHECK(revision_sha256 ~ '^[0-9a-f]{64}$'),
  observed_at TIMESTAMPTZ NOT NULL,
  available_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  text_ciphertext BYTEA,
  encryption_key_ref TEXT NOT NULL CHECK(length(encryption_key_ref) BETWEEN 1 AND 128),
  expires_at TIMESTAMPTZ NOT NULL,
  purged_at TIMESTAMPTZ,
  PRIMARY KEY(source_system,source_event_kind,event_key,revision_sha256),
  FOREIGN KEY(source_system,source_event_kind,event_key)
    REFERENCES timeline_events(source_system,source_event_kind,event_key),
  CHECK(observed_at<=available_at),
  CHECK(expires_at>available_at AND expires_at<=available_at+INTERVAL '30 days'),
  CHECK((text_ciphertext IS NOT NULL AND purged_at IS NULL) OR
        (text_ciphertext IS NULL AND purged_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_event_text_expiry ON event_text_snapshots(expires_at)
 WHERE purged_at IS NULL;

-- Append-only provenance for feature and signal computations.
CREATE TABLE IF NOT EXISTS analytics_lineage (
  lineage_id BIGSERIAL PRIMARY KEY,
  artifact_kind TEXT NOT NULL CHECK(artifact_kind IN ('daily_snapshot','feature_snapshot','alert','backtest')),
  artifact_key TEXT NOT NULL CHECK(length(artifact_key) BETWEEN 1 AND 512),
  input_kind TEXT NOT NULL CHECK(input_kind IN ('source_event','token_link','ai_analysis','model','coverage')),
  input_key TEXT NOT NULL CHECK(length(input_key) BETWEEN 1 AND 512),
  input_sha256 TEXT NOT NULL CHECK(input_sha256 ~ '^[0-9a-f]{64}$'),
  input_available_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(artifact_kind,artifact_key,input_kind,input_key,input_sha256)
);
CREATE INDEX IF NOT EXISTS idx_lineage_artifact ON analytics_lineage(artifact_kind,artifact_key);

-- Queue and audit: late source events, edit/delete, link invalidation and model changes.
CREATE TABLE IF NOT EXISTS analytics_invalidation_queue (
  invalidation_id BIGSERIAL PRIMARY KEY,
  canonical_token_id TEXT NOT NULL CHECK(length(canonical_token_id) BETWEEN 1 AND 256),
  source_system TEXT NOT NULL CHECK(source_system IN ('x','tg','blockchain','derived')),
  event_kind TEXT NOT NULL CHECK(length(event_kind) BETWEEN 1 AND 128),
  event_key TEXT NOT NULL CHECK(length(event_key) BETWEEN 1 AND 512),
  reason TEXT NOT NULL CHECK(reason IN ('edit','delete','link_invalidated','backfill','model_changed','late_outcome')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  queued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  processed_at TIMESTAMPTZ,
  UNIQUE(canonical_token_id,source_system,event_kind,event_key,reason),
  CHECK(processed_at IS NULL OR status IN ('completed','failed'))
);
CREATE INDEX IF NOT EXISTS idx_invalidation_pending ON analytics_invalidation_queue(status,queued_at);
CREATE TABLE IF NOT EXISTS analytics_invalidation_log (
  log_id BIGSERIAL PRIMARY KEY,
  invalidation_id BIGINT NOT NULL REFERENCES analytics_invalidation_queue(invalidation_id),
  transition TEXT NOT NULL CHECK(transition IN ('queued','claimed','recomputed','failed')),
  artifact_key TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- A validation is evidence from an actual COMPLETED backtest, not a caller-supplied string.
CREATE TABLE IF NOT EXISTS signal_validation_registry (
  validation_id BIGSERIAL PRIMARY KEY,
  signal_version TEXT NOT NULL CHECK(length(signal_version) BETWEEN 1 AND 128),
  backtest_run_id UUID NOT NULL REFERENCES backtest_runs(run_id),
  method TEXT NOT NULL CHECK(method IN ('walk_forward','holdout','expanding_window','k_fold')),
  method_params JSONB NOT NULL CHECK(jsonb_typeof(method_params)='object'),
  reproducibility_hash TEXT NOT NULL CHECK(reproducibility_hash ~ '^[0-9a-f]{64}$'),
  dataset_cutoff TIMESTAMPTZ NOT NULL,
  validation_status TEXT NOT NULL CHECK(validation_status IN ('passed','failed','inconclusive')),
  published_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  deployment_valid_until TIMESTAMPTZ NOT NULL,
  UNIQUE(signal_version,backtest_run_id,reproducibility_hash),
  CHECK(deployment_valid_until>published_at),
  CHECK(dataset_cutoff<=published_at)
);
CREATE INDEX IF NOT EXISTS idx_signal_validation_active ON signal_validation_registry
 (signal_version,validation_status,deployment_valid_until DESC);

-- Ledger is append-only by request ID. Estimated cost is NOT a provider invoice.
CREATE TABLE IF NOT EXISTS ai_cost_ledger (
  request_id UUID PRIMARY KEY,
  provider_id TEXT NOT NULL CHECK(length(provider_id) BETWEEN 1 AND 64),
  model_id TEXT NOT NULL CHECK(length(model_id) BETWEEN 1 AND 128),
  task TEXT NOT NULL CHECK(task IN ('sentiment','narrative','explanation','embedding')),
  source_system TEXT CHECK(source_system IN ('x','tg')),
  source_event_key TEXT,
  input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens>=0),
  output_tokens INTEGER CHECK(output_tokens IS NULL OR output_tokens>=0),
  estimated_cost_usd NUMERIC CHECK(estimated_cost_usd IS NULL OR estimated_cost_usd>=0),
  billed_cost_usd NUMERIC CHECK(billed_cost_usd IS NULL OR billed_cost_usd>=0),
  status TEXT NOT NULL CHECK(status IN ('completed','failed','unknown')),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_ai_cost_daily ON ai_cost_ledger(recorded_at DESC,provider_id);

-- Gateway integration MUST log approved and rejected requests WITHOUT credentials or message text.
CREATE TABLE IF NOT EXISTS gateway_auth_log (
  request_id UUID PRIMARY KEY,
  principal_hash TEXT CHECK(principal_hash IS NULL OR principal_hash ~ '^[0-9a-f]{64}$'),
  role TEXT CHECK(role IS NULL OR length(role)<=64),
  operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 128),
  allowed BOOLEAN NOT NULL,
  denial_code TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK(allowed OR denial_code IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_gateway_auth_time ON gateway_auth_log(recorded_at DESC);

-- A database role that inserts validation rows must be separate from the
-- collector and public API roles. Only a validation producer should receive INSERT.
ALTER TABLE signal_validation_registry ADD COLUMN IF NOT EXISTS validation_report JSONB
  NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(validation_report)='object');
