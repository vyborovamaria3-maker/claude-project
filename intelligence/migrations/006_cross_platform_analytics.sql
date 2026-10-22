-- Additive cross-platform analytics schema. Apply after migrations 001-005.
-- No provider API keys or raw social message bodies belong in this schema.
CREATE TABLE IF NOT EXISTS model_registry (
  model_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  task TEXT NOT NULL CHECK (task IN ('sentiment','bot_score','token_score','narrative','embedding','explanation')),
  trained_at TIMESTAMPTZ,
  metrics JSONB CHECK (metrics IS NULL OR jsonb_typeof(metrics)='object'),
  artifact_path TEXT,
  status TEXT NOT NULL DEFAULT 'shadow' CHECK (status IN ('shadow','active','deprecated')),
  config JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(provider,name,version,task)
);

-- Coverage must be explicitly reported before an absent event can be interpreted as zero.
CREATE TABLE IF NOT EXISTS source_coverage_windows (
  source_system TEXT NOT NULL CHECK (source_system IN ('tg','x','blockchain')),
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  known_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('complete','partial','unknown')),
  evidence_count BIGINT CHECK (evidence_count IS NULL OR evidence_count >= 0),
  details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details)='object'),
  details_sha256 TEXT NOT NULL CHECK (details_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(source_system,window_start,window_end,known_at),
  CHECK (window_start < window_end),
  CHECK (status <> 'complete' OR known_at >= window_end)
);
CREATE INDEX IF NOT EXISTS idx_source_coverage_asof
  ON source_coverage_windows(source_system,window_start,window_end,known_at DESC);

CREATE TABLE IF NOT EXISTS token_daily_cross_platform (
  canonical_token_id TEXT NOT NULL,
  day DATE NOT NULL,
  as_of TIMESTAMPTZ NOT NULL,
  max_input_observed_at TIMESTAMPTZ NOT NULL,
  tg_mentions BIGINT CHECK (tg_mentions IS NULL OR tg_mentions >= 0),
  tg_unique_authors BIGINT CHECK (tg_unique_authors IS NULL OR tg_unique_authors >= 0),
  tg_copypasta_ratio NUMERIC CHECK (tg_copypasta_ratio IS NULL OR tg_copypasta_ratio BETWEEN 0 AND 1),
  tg_sentiment_score NUMERIC CHECK (tg_sentiment_score IS NULL OR tg_sentiment_score BETWEEN -1 AND 1),
  tg_scam_ratio NUMERIC CHECK (tg_scam_ratio IS NULL OR tg_scam_ratio BETWEEN 0 AND 1),
  x_mentions BIGINT CHECK (x_mentions IS NULL OR x_mentions >= 0),
  x_unique_authors BIGINT CHECK (x_unique_authors IS NULL OR x_unique_authors >= 0),
  x_bot_ratio NUMERIC CHECK (x_bot_ratio IS NULL OR x_bot_ratio BETWEEN 0 AND 1),
  x_sentiment_score NUMERIC CHECK (x_sentiment_score IS NULL OR x_sentiment_score BETWEEN -1 AND 1),
  chain_trades BIGINT CHECK (chain_trades IS NULL OR chain_trades >= 0),
  chain_unique_wallets BIGINT CHECK (chain_unique_wallets IS NULL OR chain_unique_wallets >= 0),
  chain_volume_usd NUMERIC CHECK (chain_volume_usd IS NULL OR chain_volume_usd >= 0),
  chain_liquidity_usd NUMERIC CHECK (chain_liquidity_usd IS NULL OR chain_liquidity_usd >= 0),
  chain_smart_money_bought BIGINT CHECK (chain_smart_money_bought IS NULL OR chain_smart_money_bought >= 0),
  chain_rug_risk NUMERIC CHECK (chain_rug_risk IS NULL OR chain_rug_risk BETWEEN 0 AND 1),
  tg_mentions_z_1h NUMERIC,
  x_mentions_z_1h NUMERIC,
  chain_volume_z_1h NUMERIC,
  first_mention_tg_at TIMESTAMPTZ,
  first_mention_x_at TIMESTAMPTZ,
  first_trade_at TIMESTAMPTZ,
  attention_score NUMERIC,
  credibility_score NUMERIC CHECK (credibility_score IS NULL OR credibility_score BETWEEN 0 AND 1),
  risk_score NUMERIC CHECK (risk_score IS NULL OR risk_score BETWEEN 0 AND 1),
  momentum_score NUMERIC,
  score_version TEXT NOT NULL,
  score_reason JSONB NOT NULL CHECK (jsonb_typeof(score_reason)='object'),
  source_coverage JSONB NOT NULL CHECK (jsonb_typeof(source_coverage)='object'),
  data_confidence NUMERIC NOT NULL CHECK (data_confidence BETWEEN 0 AND 1),
  snapshot_sha256 TEXT NOT NULL CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(canonical_token_id,day,as_of),
  CHECK (as_of >= (day::timestamp AT TIME ZONE 'UTC')),
  CHECK (max_input_observed_at <= as_of)
);
CREATE INDEX IF NOT EXISTS idx_cross_platform_token_asof
  ON token_daily_cross_platform(canonical_token_id,as_of DESC);
CREATE INDEX IF NOT EXISTS idx_cross_platform_day_score
  ON token_daily_cross_platform(day DESC,momentum_score DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS token_narratives (
  narrative_id TEXT NOT NULL,
  canonical_token_id TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ,
  spread_velocity NUMERIC,
  peak_at TIMESTAMPTZ,
  sources TEXT[] NOT NULL DEFAULT '{}',
  model_id TEXT REFERENCES model_registry(model_id),
  confidence NUMERIC CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_refs)='array'),
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(narrative_id,canonical_token_id,first_seen_at),
  CHECK (last_seen_at IS NULL OR last_seen_at >= first_seen_at)
);
CREATE INDEX IF NOT EXISTS idx_token_narratives_token_time
  ON token_narratives(canonical_token_id,first_seen_at DESC);

CREATE TABLE IF NOT EXISTS token_correlations (
  correlation_id BIGSERIAL PRIMARY KEY,
  canonical_token_id TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  event_at TIMESTAMPTZ NOT NULL,
  outcome_kind TEXT NOT NULL,
  outcome_at TIMESTAMPTZ,
  lift NUMERIC,
  ci_low NUMERIC,
  ci_high NUMERIC,
  p_value NUMERIC CHECK (p_value IS NULL OR p_value BETWEEN 0 AND 1),
  baseline JSONB NOT NULL CHECK (jsonb_typeof(baseline)='object'),
  sample_size BIGINT NOT NULL CHECK (sample_size >= 0),
  model_id TEXT REFERENCES model_registry(model_id),
  evaluated_at TIMESTAMPTZ NOT NULL,
  data_cutoff_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (data_cutoff_at <= evaluated_at),
  CHECK (outcome_at IS NULL OR outcome_at >= event_at)
);
CREATE INDEX IF NOT EXISTS idx_token_correlations_significance
  ON token_correlations(canonical_token_id,p_value ASC NULLS LAST,evaluated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_token_correlations_observation
  ON token_correlations(canonical_token_id,event_kind,event_at,outcome_kind,evaluated_at);

CREATE TABLE IF NOT EXISTS token_alerts (
  alert_id BIGSERIAL PRIMARY KEY,
  canonical_token_id TEXT NOT NULL,
  alert_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info','low','medium','high','critical')),
  triggered_at TIMESTAMPTZ NOT NULL,
  as_of TIMESTAMPTZ NOT NULL,
  score NUMERIC,
  score_version TEXT,
  features JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(features)='object'),
  evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_refs)='array'),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','delivered','acknowledged','resolved')),
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (as_of <= triggered_at),
  UNIQUE(canonical_token_id,alert_type,triggered_at)
);
CREATE INDEX IF NOT EXISTS idx_token_alerts_active
  ON token_alerts(status,triggered_at DESC) WHERE status <> 'resolved';

-- Outcomes are explicit labels from a source with declared coverage, never inferred from missing rows.
CREATE TABLE IF NOT EXISTS token_outcomes (
  outcome_id BIGSERIAL PRIMARY KEY,
  canonical_token_id TEXT NOT NULL,
  outcome_kind TEXT NOT NULL,
  outcome_at TIMESTAMPTZ NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  label BOOLEAN NOT NULL,
  value NUMERIC,
  source_system TEXT NOT NULL CHECK (source_system IN ('tg','x','blockchain','derived')),
  evidence_ref TEXT,
  label_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (observed_at >= outcome_at),
  UNIQUE(canonical_token_id,outcome_kind,outcome_at,label_version)
);
CREATE INDEX IF NOT EXISTS idx_token_outcomes_lookup
  ON token_outcomes(canonical_token_id,outcome_kind,outcome_at,observed_at);

CREATE TABLE IF NOT EXISTS backtest_runs (
  run_id UUID PRIMARY KEY,
  signal_name TEXT NOT NULL,
  outcome_kind TEXT NOT NULL,
  from_at TIMESTAMPTZ NOT NULL,
  to_at TIMESTAMPTZ NOT NULL,
  horizon_hours INTEGER NOT NULL CHECK (horizon_hours BETWEEN 1 AND 720),
  threshold NUMERIC NOT NULL,
  baseline_kind TEXT NOT NULL CHECK (baseline_kind IN ('market_average','random')),
  status TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metrics)='object'),
  feature_version TEXT,
  model_id TEXT REFERENCES model_registry(model_id),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  data_cutoff_at TIMESTAMPTZ,
  error_code TEXT,
  CHECK (from_at < to_at),
  CHECK (completed_at IS NULL OR completed_at >= started_at),
  CHECK (data_cutoff_at IS NULL OR data_cutoff_at <= completed_at)
);
CREATE INDEX IF NOT EXISTS idx_backtest_runs_recent
  ON backtest_runs(completed_at DESC) WHERE status='completed';

CREATE TABLE IF NOT EXISTS backtest_results (
  run_id UUID NOT NULL REFERENCES backtest_runs(run_id) ON DELETE CASCADE,
  canonical_token_id TEXT NOT NULL,
  signal_at TIMESTAMPTZ NOT NULL,
  max_input_observed_at TIMESTAMPTZ NOT NULL,
  outcome_at TIMESTAMPTZ NOT NULL,
  outcome_observed_at TIMESTAMPTZ NOT NULL,
  score NUMERIC NOT NULL,
  outcome_label BOOLEAN NOT NULL,
  selected BOOLEAN NOT NULL,
  outcome_value NUMERIC,
  evidence_ref TEXT,
  PRIMARY KEY(run_id,canonical_token_id,signal_at),
  CHECK (max_input_observed_at <= signal_at),
  CHECK (outcome_at > signal_at),
  CHECK (outcome_observed_at >= outcome_at)
);

CREATE TABLE IF NOT EXISTS signal_explanations (
  explanation_id BIGSERIAL PRIMARY KEY,
  alert_id BIGINT NOT NULL REFERENCES token_alerts(alert_id) ON DELETE CASCADE,
  model_id TEXT NOT NULL REFERENCES model_registry(model_id),
  trace_id UUID NOT NULL,
  explanation TEXT NOT NULL CHECK (length(explanation) BETWEEN 1 AND 4000),
  evidence_refs JSONB NOT NULL CHECK (jsonb_typeof(evidence_refs)='array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(alert_id,model_id)
);
