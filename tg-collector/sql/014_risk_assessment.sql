ALTER TABLE tg_token_outcomes
  ADD COLUMN IF NOT EXISTS risk_assessed BOOLEAN NOT NULL DEFAULT FALSE;
COMMENT ON COLUMN tg_token_outcomes.risk_assessed IS
  'True only when a risk outcome was assessed from explicit evidence; absence of a recorded event is not a clean bill of health.';
