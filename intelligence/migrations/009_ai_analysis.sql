-- AI results are destination-only; raw collector text stays in the source database.
CREATE TABLE IF NOT EXISTS ai_message_analyses (
  analysis_id BIGSERIAL PRIMARY KEY,
  source_system TEXT NOT NULL CHECK (source_system IN ('x','tg')),
  source_event_kind TEXT NOT NULL,
  event_key TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  canonical_token_ids JSONB NOT NULL CHECK (jsonb_typeof(canonical_token_ids)='array'),
  text_sha256 TEXT NOT NULL CHECK (text_sha256 ~ '^[a-f0-9]{64}$'),
  task TEXT NOT NULL CHECK (task IN ('sentiment','narrative')),
  model_id TEXT NOT NULL REFERENCES model_registry(model_id),
  model_version TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  trace_id UUID NOT NULL,
  result JSONB NOT NULL CHECK (jsonb_typeof(result)='object'),
  source_observed_at TIMESTAMPTZ NOT NULL,
  analyzed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(source_system,source_event_kind,event_key)
    REFERENCES timeline_events(source_system,source_event_kind,event_key),
  UNIQUE(source_system,source_event_kind,event_key,text_sha256,task,model_id),
  CHECK (source_observed_at <= analyzed_at)
);
CREATE INDEX IF NOT EXISTS idx_ai_message_lookup ON ai_message_analyses
  (source_system,source_event_kind,event_key,task,analyzed_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_message_tokens ON ai_message_analyses USING gin(canonical_token_ids);

-- Bounded retry bookkeeping reuses the destination, without changing source queues or ACKs.
CREATE TABLE IF NOT EXISTS ai_message_attempts (
  source_system TEXT NOT NULL,
  source_event_kind TEXT NOT NULL,
  event_key TEXT NOT NULL,
  task TEXT NOT NULL,
  model_id TEXT NOT NULL REFERENCES model_registry(model_id),
  attempts INTEGER NOT NULL CHECK(attempts > 0),
  next_attempt_at TIMESTAMPTZ NOT NULL,
  error_code TEXT NOT NULL CHECK(error_code ~ '^[a-z0-9_]{1,64}$'),
  PRIMARY KEY(source_system,source_event_kind,event_key,task,model_id),
  FOREIGN KEY(source_system,source_event_kind,event_key)
    REFERENCES timeline_events(source_system,source_event_kind,event_key)
);
ALTER TABLE signal_explanations ADD COLUMN IF NOT EXISTS grounding JSONB
  CHECK (grounding IS NULL OR jsonb_typeof(grounding)='object');
CREATE TABLE IF NOT EXISTS ai_explanation_attempts (
  alert_id BIGINT NOT NULL REFERENCES token_alerts(alert_id) ON DELETE CASCADE,
  model_id TEXT NOT NULL REFERENCES model_registry(model_id),
  attempts INTEGER NOT NULL CHECK(attempts>0),
  next_attempt_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(alert_id,model_id)
);
CREATE TABLE IF NOT EXISTS ai_refresh_pending (
  canonical_token_id TEXT NOT NULL,
  day DATE NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(canonical_token_id,day)
);
