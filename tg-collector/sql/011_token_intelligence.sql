-- Solana token intelligence: candidates are not treated as confirmed tokens until
-- the configured on-chain provider verifies the mint account.
ALTER TABLE tg_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
ALTER TABLE tg_message_links
  ADD COLUMN IF NOT EXISTS extractor_name TEXT NOT NULL DEFAULT 'telegram-text',
  ADD COLUMN IF NOT EXISTS orphaned BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tg_runtime
  ADD COLUMN IF NOT EXISTS worker_version TEXT,
  ADD COLUMN IF NOT EXISTS last_error_code TEXT;

UPDATE tg_message_links l
SET orphaned = (m.deleted_at IS NOT NULL)
FROM tg_messages m
WHERE m.source_id = l.source_id AND m.message_id = l.message_id
  AND l.orphaned IS DISTINCT FROM (m.deleted_at IS NOT NULL);

CREATE INDEX IF NOT EXISTS tg_messages_analysis_pending_v3_idx
  ON tg_messages(source_id,message_id) WHERE analysis_version < 3;
CREATE INDEX IF NOT EXISTS tg_message_links_active_target_idx
  ON tg_message_links(target_kind,target_key,source_id) WHERE orphaned = FALSE;

CREATE TABLE IF NOT EXISTS tg_analysis_versions (
  extractor_name TEXT NOT NULL,
  analysis_version SMALLINT NOT NULL CHECK (analysis_version > 0),
  description TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  released_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (extractor_name, analysis_version)
);
UPDATE tg_analysis_versions SET is_active = FALSE WHERE extractor_name = 'telegram-text';
INSERT INTO tg_analysis_versions(extractor_name,analysis_version,description,is_active,metadata)
VALUES ('telegram-text',2,'Legacy Telegram text evidence extractor',FALSE,'{"source":"migration"}'::jsonb)
ON CONFLICT (extractor_name,analysis_version) DO NOTHING;
INSERT INTO tg_analysis_versions(extractor_name,analysis_version,description,is_active,metadata)
VALUES ('telegram-text',3,'Solana candidate, ticker and normalized-copy extraction',TRUE,'{"token_candidates":true,"ticker_mentions":true,"copy_fingerprints":true}'::jsonb)
ON CONFLICT (extractor_name,analysis_version) DO UPDATE SET is_active=TRUE;

CREATE TABLE IF NOT EXISTS tg_tokens (
  chain_id TEXT NOT NULL,
  mint TEXT NOT NULL,
  symbol TEXT,
  name TEXT,
  decimals SMALLINT CHECK (decimals BETWEEN 0 AND 30),
  token_program TEXT,
  created_at_chain TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (metadata_status IN ('pending','partial','verified','unavailable')),
  metadata_provider TEXT,
  metadata_updated_at TIMESTAMPTZ,
  PRIMARY KEY (chain_id,mint)
);
CREATE INDEX IF NOT EXISTS tg_tokens_symbol_idx ON tg_tokens(lower(symbol)) WHERE symbol IS NOT NULL;

CREATE TABLE IF NOT EXISTS tg_token_candidates (
  source_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  chain_id TEXT NOT NULL DEFAULT 'solana-mainnet',
  candidate_type TEXT NOT NULL CHECK (candidate_type IN ('address','ticker')),
  candidate_key TEXT NOT NULL,
  raw_value TEXT NOT NULL,
  resolution_status TEXT NOT NULL DEFAULT 'unresolved'
    CHECK (resolution_status IN ('unresolved','confirmed_token','not_token','ambiguous')),
  confidence NUMERIC(5,4) CHECK (confidence BETWEEN 0 AND 1),
  provider TEXT,
  checked_at TIMESTAMPTZ,
  analysis_version SMALLINT NOT NULL,
  extractor_name TEXT NOT NULL DEFAULT 'telegram-text',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id,message_id,chain_id,candidate_type,candidate_key,analysis_version),
  FOREIGN KEY (source_id,message_id) REFERENCES tg_messages(source_id,message_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS tg_token_candidates_pending_idx
  ON tg_token_candidates(last_seen_at,source_id,message_id)
  WHERE candidate_type='address' AND resolution_status='unresolved';
CREATE INDEX IF NOT EXISTS tg_token_candidates_key_idx
  ON tg_token_candidates(chain_id,candidate_key,resolution_status);

CREATE TABLE IF NOT EXISTS tg_ticker_mentions (
  source_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  chain_id TEXT NOT NULL DEFAULT 'solana-mainnet',
  ticker TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  message_date TIMESTAMPTZ,
  analysis_version SMALLINT NOT NULL,
  extractor_name TEXT NOT NULL DEFAULT 'telegram-text',
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id,message_id,chain_id,ticker,analysis_version),
  FOREIGN KEY (source_id,message_id) REFERENCES tg_messages(source_id,message_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS tg_ticker_mentions_ticker_date_idx
  ON tg_ticker_mentions(ticker,message_date DESC);

CREATE TABLE IF NOT EXISTS tg_ticker_registry (
  id BIGSERIAL PRIMARY KEY,
  ticker TEXT NOT NULL,
  chain_id TEXT NOT NULL DEFAULT 'solana-mainnet',
  mint TEXT,
  resolution_status TEXT NOT NULL DEFAULT 'unresolved'
    CHECK (resolution_status IN ('confirmed','probable','unresolved')),
  confidence NUMERIC(5,4) NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
  evidence_count BIGINT NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (chain_id,mint) REFERENCES tg_tokens(chain_id,mint) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS tg_ticker_registry_mint_unique_idx
  ON tg_ticker_registry(ticker,chain_id,mint) WHERE mint IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tg_ticker_registry_unresolved_unique_idx
  ON tg_ticker_registry(ticker,chain_id) WHERE mint IS NULL AND resolution_status='unresolved';
CREATE INDEX IF NOT EXISTS tg_ticker_registry_lookup_idx
  ON tg_ticker_registry(ticker,chain_id,resolution_status);

CREATE TABLE IF NOT EXISTS tg_token_mentions (
  source_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  chain_id TEXT NOT NULL,
  mint TEXT NOT NULL,
  mention_type TEXT NOT NULL CHECK (mention_type IN ('mint','ticker','name','link')),
  resolution_status TEXT NOT NULL CHECK (resolution_status IN ('confirmed','probable')),
  confidence NUMERIC(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  message_date TIMESTAMPTZ,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  analysis_version SMALLINT NOT NULL,
  extractor_name TEXT NOT NULL DEFAULT 'telegram-text',
  copy_cluster_id BIGINT,
  orphaned BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (source_id,message_id,chain_id,mint,mention_type,analysis_version),
  FOREIGN KEY (source_id,message_id) REFERENCES tg_messages(source_id,message_id) ON DELETE CASCADE,
  FOREIGN KEY (chain_id,mint) REFERENCES tg_tokens(chain_id,mint) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS tg_token_mentions_mint_date_idx
  ON tg_token_mentions(chain_id,mint,message_date DESC) WHERE orphaned=FALSE;
CREATE INDEX IF NOT EXISTS tg_token_mentions_source_date_idx
  ON tg_token_mentions(source_id,message_date DESC) WHERE orphaned=FALSE;
CREATE INDEX IF NOT EXISTS tg_token_mentions_version_idx
  ON tg_token_mentions(extractor_name,analysis_version,orphaned);

CREATE TABLE IF NOT EXISTS tg_token_first_mentions (
  chain_id TEXT NOT NULL,
  mint TEXT NOT NULL,
  source_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  message_date TIMESTAMPTZ,
  observed_at TIMESTAMPTZ NOT NULL,
  coverage_status TEXT NOT NULL,
  analysis_version SMALLINT NOT NULL,
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id,mint),
  FOREIGN KEY (chain_id,mint) REFERENCES tg_tokens(chain_id,mint) ON DELETE CASCADE,
  FOREIGN KEY (source_id,message_id) REFERENCES tg_messages(source_id,message_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS tg_token_first_mentions_source_idx
  ON tg_token_first_mentions(source_id,message_date DESC);

CREATE TABLE IF NOT EXISTS tg_copy_clusters (
  id BIGSERIAL PRIMARY KEY,
  fingerprint CHAR(64) NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('normalized_exact')),
  analysis_version SMALLINT NOT NULL,
  member_count INTEGER NOT NULL DEFAULT 0 CHECK (member_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(fingerprint,method,analysis_version)
);
CREATE TABLE IF NOT EXISTS tg_message_fingerprints (
  source_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  fingerprint CHAR(64) NOT NULL,
  normalized_length INTEGER NOT NULL,
  cluster_id BIGINT REFERENCES tg_copy_clusters(id) ON DELETE SET NULL,
  method TEXT NOT NULL DEFAULT 'normalized_exact',
  analysis_version SMALLINT NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(source_id,message_id,analysis_version),
  FOREIGN KEY(source_id,message_id) REFERENCES tg_messages(source_id,message_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS tg_message_fingerprints_cluster_idx
  ON tg_message_fingerprints(cluster_id) WHERE cluster_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tg_message_fingerprints_hash_idx
  ON tg_message_fingerprints(fingerprint,analysis_version);

CREATE TABLE IF NOT EXISTS tg_message_similarity (
  source_a BIGINT NOT NULL,
  message_a BIGINT NOT NULL,
  source_b BIGINT NOT NULL,
  message_b BIGINT NOT NULL,
  similarity NUMERIC(5,4) NOT NULL CHECK (similarity BETWEEN 0 AND 1),
  method TEXT NOT NULL,
  model_version TEXT NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(source_a,message_a,source_b,message_b,method),
  CHECK ((source_a, message_a) < (source_b, message_b)),
  FOREIGN KEY(source_a,message_a) REFERENCES tg_messages(source_id,message_id) ON DELETE CASCADE,
  FOREIGN KEY(source_b,message_b) REFERENCES tg_messages(source_id,message_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tg_token_velocity (
  chain_id TEXT NOT NULL,
  mint TEXT NOT NULL,
  window_name TEXT NOT NULL CHECK (window_name IN ('5m','15m','1h','6h','24h')),
  window_start TIMESTAMPTZ NOT NULL,
  mentions INTEGER NOT NULL DEFAULT 0,
  unique_sources INTEGER NOT NULL DEFAULT 0,
  unique_authors INTEGER,
  independent_clusters INTEGER NOT NULL DEFAULT 0,
  velocity NUMERIC(14,4) NOT NULL DEFAULT 0,
  acceleration NUMERIC(14,4),
  z_score NUMERIC(14,4),
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(chain_id,mint,window_name,window_start),
  FOREIGN KEY(chain_id,mint) REFERENCES tg_tokens(chain_id,mint) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS tg_token_velocity_latest_idx
  ON tg_token_velocity(chain_id,mint,window_name,computed_at DESC);

CREATE TABLE IF NOT EXISTS tg_channel_metrics_daily (
  source_id BIGINT NOT NULL REFERENCES tg_sources(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  analysis_version SMALLINT NOT NULL,
  messages_total INTEGER NOT NULL DEFAULT 0,
  address_candidates INTEGER NOT NULL DEFAULT 0,
  ticker_mentions INTEGER NOT NULL DEFAULT 0,
  confirmed_token_mentions INTEGER NOT NULL DEFAULT 0,
  unique_confirmed_tokens INTEGER NOT NULL DEFAULT 0,
  unique_token_discoveries INTEGER NOT NULL DEFAULT 0,
  first_mentions INTEGER NOT NULL DEFAULT 0,
  unique_copy_clusters INTEGER NOT NULL DEFAULT 0,
  copypasta_ratio NUMERIC(6,5) CHECK (copypasta_ratio BETWEEN 0 AND 1),
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(source_id,day,analysis_version)
);
CREATE INDEX IF NOT EXISTS tg_channel_metrics_daily_day_idx
  ON tg_channel_metrics_daily(day DESC,source_id);

CREATE TABLE IF NOT EXISTS tg_channel_scores (
  source_id BIGINT NOT NULL REFERENCES tg_sources(id) ON DELETE CASCADE,
  model_version TEXT NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  discovery_score NUMERIC(7,4),
  outcome_score NUMERIC(7,4),
  originality_score NUMERIC(7,4),
  risk_score NUMERIC(7,4),
  composite_score NUMERIC(7,4),
  sample_size INTEGER NOT NULL DEFAULT 0,
  confidence_lower NUMERIC(7,4),
  confidence_upper NUMERIC(7,4),
  features JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY(source_id,model_version,computed_at)
);
CREATE INDEX IF NOT EXISTS tg_channel_scores_latest_idx
  ON tg_channel_scores(source_id,computed_at DESC);

CREATE TABLE IF NOT EXISTS tg_token_market_snapshots (
  chain_id TEXT NOT NULL,
  mint TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  price_usd NUMERIC(30,12) CHECK (price_usd IS NULL OR price_usd >= 0),
  liquidity_usd NUMERIC(30,4) CHECK (liquidity_usd IS NULL OR liquidity_usd >= 0),
  volume_5m NUMERIC(30,4) CHECK (volume_5m IS NULL OR volume_5m >= 0),
  volume_1h NUMERIC(30,4) CHECK (volume_1h IS NULL OR volume_1h >= 0),
  market_cap_estimate NUMERIC(30,4) CHECK (market_cap_estimate IS NULL OR market_cap_estimate >= 0),
  provider TEXT NOT NULL,
  data_quality TEXT NOT NULL CHECK (data_quality IN ('observed','partial','stale','unavailable')),
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY(chain_id,mint,observed_at,provider),
  FOREIGN KEY(chain_id,mint) REFERENCES tg_tokens(chain_id,mint) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS tg_market_snapshots_time_idx
  ON tg_token_market_snapshots(chain_id,mint,observed_at DESC);

CREATE TABLE IF NOT EXISTS tg_token_outcomes (
  source_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  chain_id TEXT NOT NULL,
  mint TEXT NOT NULL,
  analysis_version SMALLINT NOT NULL,
  mention_time TIMESTAMPTZ,
  price_at_mention NUMERIC(30,12),
  price_5m NUMERIC(30,12),
  price_1h NUMERIC(30,12),
  price_6h NUMERIC(30,12),
  price_24h NUMERIC(30,12),
  price_7d NUMERIC(30,12),
  max_gain_pct NUMERIC(18,6),
  max_drawdown_pct NUMERIC(18,6),
  liquidity_at_mention NUMERIC(30,4),
  outcome_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (outcome_status IN ('pending','complete','insufficient_data','risk_confirmed')),
  risk_event BOOLEAN NOT NULL DEFAULT FALSE,
  market_provider TEXT,
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  model_version TEXT NOT NULL,
  PRIMARY KEY(source_id,message_id,chain_id,mint,analysis_version,model_version),
  FOREIGN KEY(source_id,message_id) REFERENCES tg_messages(source_id,message_id) ON DELETE CASCADE,
  FOREIGN KEY(chain_id,mint) REFERENCES tg_tokens(chain_id,mint) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS tg_token_outcomes_mint_idx
  ON tg_token_outcomes(chain_id,mint,mention_time DESC);

CREATE TABLE IF NOT EXISTS tg_signals (
  id BIGSERIAL PRIMARY KEY,
  signal_type TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  mint TEXT NOT NULL,
  source_id BIGINT,
  message_id BIGINT,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confidence NUMERIC(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  features JSONB NOT NULL DEFAULT '{}'::jsonb,
  model_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate','reviewed','dismissed','validated')),
  FOREIGN KEY(chain_id,mint) REFERENCES tg_tokens(chain_id,mint) ON DELETE CASCADE,
  FOREIGN KEY(source_id,message_id) REFERENCES tg_messages(source_id,message_id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS tg_signals_message_dedupe_idx
  ON tg_signals(signal_type,chain_id,mint,source_id,message_id,model_version)
  WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tg_signals_recent_idx ON tg_signals(detected_at DESC,signal_type);

CREATE TABLE IF NOT EXISTS tg_backtest_runs (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  model_version TEXT NOT NULL,
  time_start TIMESTAMPTZ NOT NULL,
  time_end TIMESTAMPTZ NOT NULL,
  parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  baseline_name TEXT NOT NULL,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','completed','failed')),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK(time_end > time_start)
);
CREATE TABLE IF NOT EXISTS tg_backtest_results (
  run_id BIGINT NOT NULL REFERENCES tg_backtest_runs(id) ON DELETE CASCADE,
  signal_id BIGINT NOT NULL REFERENCES tg_signals(id) ON DELETE CASCADE,
  chain_id TEXT NOT NULL,
  mint TEXT NOT NULL,
  source_id BIGINT,
  message_id BIGINT,
  outcome_horizon TEXT NOT NULL CHECK (outcome_horizon IN ('5m','1h','6h','24h','7d')),
  forward_return_pct NUMERIC(18,6),
  max_drawdown_pct NUMERIC(18,6),
  baseline_return_pct NUMERIC(18,6),
  labels JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY(run_id,signal_id),
  FOREIGN KEY(chain_id,mint) REFERENCES tg_tokens(chain_id,mint) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tg_narratives (
  id BIGSERIAL PRIMARY KEY,
  narrative_name TEXT NOT NULL UNIQUE,
  description TEXT,
  rules JSONB NOT NULL DEFAULT '{}'::jsonb,
  model_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tg_token_narratives (
  chain_id TEXT NOT NULL,
  mint TEXT NOT NULL,
  narrative_id BIGINT NOT NULL REFERENCES tg_narratives(id) ON DELETE CASCADE,
  confidence NUMERIC(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  evidence_count INTEGER NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  model_version TEXT NOT NULL,
  PRIMARY KEY(chain_id,mint,narrative_id,model_version),
  FOREIGN KEY(chain_id,mint) REFERENCES tg_tokens(chain_id,mint) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tg_coordination_events (
  id BIGSERIAL PRIMARY KEY,
  chain_id TEXT NOT NULL,
  mint TEXT NOT NULL,
  source_ids BIGINT[] NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  similarity_score NUMERIC(5,4) NOT NULL CHECK (similarity_score BETWEEN 0 AND 1),
  confidence NUMERIC(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  model_version TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'unreviewed'
    CHECK (review_status IN ('unreviewed','reviewed','dismissed')),
  CHECK(window_end >= window_start),
  FOREIGN KEY(chain_id,mint) REFERENCES tg_tokens(chain_id,mint) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS tg_coordination_events_recent_idx
  ON tg_coordination_events(detected_at DESC,chain_id,mint);

CREATE TABLE IF NOT EXISTS tg_author_bot_scores (
  author_id TEXT NOT NULL,
  bot_score NUMERIC(5,4) NOT NULL CHECK (bot_score BETWEEN 0 AND 1),
  features JSONB NOT NULL DEFAULT '{}'::jsonb,
  model_version TEXT NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  evidence_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(author_id,model_version,computed_at)
);

CREATE TABLE IF NOT EXISTS tg_db_metrics_snapshots (
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  table_name TEXT NOT NULL,
  row_count BIGINT NOT NULL,
  size_bytes BIGINT NOT NULL,
  index_size_bytes BIGINT NOT NULL,
  PRIMARY KEY(captured_at,table_name)
);
CREATE INDEX IF NOT EXISTS tg_db_metrics_snapshots_time_idx
  ON tg_db_metrics_snapshots(captured_at DESC);

-- Policy is documented and observable, but destructive retention is opt-in.
CREATE TABLE IF NOT EXISTS tg_retention_policy (
  table_name TEXT PRIMARY KEY,
  retention_days INTEGER,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK(retention_days IS NULL OR retention_days > 0)
);
INSERT INTO tg_retention_policy(table_name,retention_days,enabled) VALUES
  ('tg_messages',730,FALSE),
  ('tg_message_links',1095,FALSE),
  ('tg_graph_daily_edges',365,FALSE),
  ('tg_token_mentions',365,FALSE),
  ('tg_token_velocity',180,FALSE),
  ('tg_token_outcomes',NULL,FALSE)
ON CONFLICT(table_name) DO NOTHING;

CREATE OR REPLACE FUNCTION tg_sync_message_evidence_lifecycle() RETURNS trigger
LANGUAGE plpgsql AS $lifecycle$
DECLARE
  affected RECORD;
  first_row RECORD;
BEGIN
  IF OLD.deleted_at IS NOT DISTINCT FROM NEW.deleted_at THEN
    RETURN NEW;
  END IF;

  UPDATE tg_message_links
  SET orphaned = (NEW.deleted_at IS NOT NULL)
  WHERE source_id=NEW.source_id AND message_id=NEW.message_id;

  UPDATE tg_token_mentions
  SET orphaned = (NEW.deleted_at IS NOT NULL)
  WHERE source_id=NEW.source_id AND message_id=NEW.message_id;

  FOR affected IN
    SELECT DISTINCT chain_id,mint FROM tg_token_mentions
    WHERE source_id=NEW.source_id AND message_id=NEW.message_id
  LOOP
    SELECT tm.source_id,tm.message_id,tm.message_date,tm.observed_at,tm.analysis_version,s.history_partial
    INTO first_row
    FROM tg_token_mentions tm
    JOIN tg_messages m USING(source_id,message_id)
    JOIN tg_sources s ON s.id=tm.source_id
    WHERE tm.chain_id=affected.chain_id AND tm.mint=affected.mint
      AND tm.orphaned=FALSE AND m.deleted_at IS NULL
    ORDER BY tm.message_date ASC NULLS LAST,tm.observed_at,tm.source_id,tm.message_id
    LIMIT 1;

    IF FOUND THEN
      INSERT INTO tg_token_first_mentions
        (chain_id,mint,source_id,message_id,message_date,observed_at,coverage_status,analysis_version,calculated_at)
      VALUES
        (affected.chain_id,affected.mint,first_row.source_id,first_row.message_id,
         first_row.message_date,first_row.observed_at,
         CASE WHEN first_row.history_partial THEN 'partial_source_history' ELSE 'collected_source_history' END,
         first_row.analysis_version,now())
      ON CONFLICT(chain_id,mint) DO UPDATE SET
        source_id=EXCLUDED.source_id,message_id=EXCLUDED.message_id,
        message_date=EXCLUDED.message_date,observed_at=EXCLUDED.observed_at,
        coverage_status=EXCLUDED.coverage_status,analysis_version=EXCLUDED.analysis_version,
        calculated_at=now();
    ELSE
      DELETE FROM tg_token_first_mentions
      WHERE chain_id=affected.chain_id AND mint=affected.mint;
    END IF;
  END LOOP;
  RETURN NEW;
END
$lifecycle$;

DO $install$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname='tg_message_evidence_lifecycle_trg'
      AND tgrelid='tg_messages'::regclass AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER tg_message_evidence_lifecycle_trg
    AFTER UPDATE OF deleted_at ON tg_messages
    FOR EACH ROW EXECUTE FUNCTION tg_sync_message_evidence_lifecycle();
  END IF;
END
$install$;

COMMENT ON TABLE tg_token_candidates IS
  'Observed Solana address/ticker candidates. An address is not a token until an on-chain provider confirms mint-account semantics.';
COMMENT ON TABLE tg_token_mentions IS
  'Token mentions only after identity resolution; links to original messages and versioned extraction evidence.';
COMMENT ON TABLE tg_token_first_mentions IS
  'Earliest mention in collected data, not proof of the earliest public mention on Telegram or the internet.';
COMMENT ON TABLE tg_channel_scores IS
  'Versioned channel score components; outcome_score remains NULL until sufficient market outcomes exist.';
COMMENT ON TABLE tg_token_market_snapshots IS
  'Provider-attributed observed market data. No synthetic or backfilled prices are inserted.';
