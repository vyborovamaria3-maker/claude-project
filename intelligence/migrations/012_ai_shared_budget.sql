-- Shared, cross-worker AI cost reservations. Requires 010_ai_cost_ledger.
-- This protective allowance is denominated in estimated USD, not invoices.
CREATE TABLE IF NOT EXISTS ai_daily_budgets (
  provider_id TEXT NOT NULL CHECK (provider_id ~ '^[a-zA-Z0-9._-]{1,64}$'),
  budget_day DATE NOT NULL,
  limit_usd NUMERIC NOT NULL CHECK (limit_usd > 0),
  used_allowance_usd NUMERIC NOT NULL DEFAULT 0 CHECK (used_allowance_usd >= 0),
  reserved_allowance_usd NUMERIC NOT NULL DEFAULT 0 CHECK (reserved_allowance_usd >= 0),
  PRIMARY KEY(provider_id,budget_day),
  CHECK (used_allowance_usd + reserved_allowance_usd <= limit_usd)
);
CREATE TABLE IF NOT EXISTS ai_budget_reservations (
  reservation_id UUID PRIMARY KEY,
  provider_id TEXT NOT NULL,
  budget_day DATE NOT NULL,
  allowance_usd NUMERIC NOT NULL CHECK (allowance_usd > 0),
  measured_cost_usd NUMERIC CHECK (measured_cost_usd IS NULL OR measured_cost_usd >= 0),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','settled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  settled_at TIMESTAMPTZ,
  FOREIGN KEY(provider_id,budget_day) REFERENCES ai_daily_budgets(provider_id,budget_day),
  CHECK ((status='reserved' AND settled_at IS NULL) OR (status='settled' AND settled_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_ai_budget_unsettled ON ai_budget_reservations(status,created_at);
