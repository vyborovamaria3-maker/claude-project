-- Intended for isolated Intelligence PostgreSQL database, after 001 and 002.
CREATE TABLE IF NOT EXISTS feature_versions (
  feature_version TEXT PRIMARY KEY,
  definition JSONB NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS chain_token_features (
  canonical_token_id TEXT NOT NULL,
  as_of TIMESTAMPTZ NOT NULL,
  max_input_observed_at TIMESTAMPTZ NOT NULL,
  feature_version TEXT NOT NULL REFERENCES feature_versions(feature_version),
  features JSONB NOT NULL CHECK (jsonb_typeof(features) = 'object'),
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (canonical_token_id, as_of, feature_version),
  CHECK (max_input_observed_at <= as_of)
);
CREATE INDEX IF NOT EXISTS idx_features_token_time
  ON chain_token_features (canonical_token_id, feature_version, as_of DESC);
