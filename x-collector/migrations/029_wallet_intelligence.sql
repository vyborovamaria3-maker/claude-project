-- Wallet intelligence layer
-- Adds analytical profile storage for blockchain entities linked to the intelligence graph.

CREATE TABLE IF NOT EXISTS ip_wallet_profiles (
  entity_id uuid PRIMARY KEY REFERENCES ip_entities(id) ON DELETE CASCADE,
  wallet_age_days INTEGER,
  first_seen_at TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ,
  funding_sources JSONB NOT NULL DEFAULT '{}'::jsonb,
  token_exposure JSONB NOT NULL DEFAULT '{}'::jsonb,
  counterparties JSONB NOT NULL DEFAULT '{}'::jsonb,
  risk_score NUMERIC(5,4),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ip_wallet_profiles_risk
ON ip_wallet_profiles(risk_score);

CREATE INDEX IF NOT EXISTS idx_ip_wallet_profiles_activity
ON ip_wallet_profiles(last_activity_at);
