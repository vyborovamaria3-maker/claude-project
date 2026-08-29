ALTER TABLE analysis_runs ADD COLUMN IF NOT EXISTS owner_id text;
ALTER TABLE telegram_ai_runs ADD COLUMN IF NOT EXISTS owner_id text;

CREATE INDEX IF NOT EXISTS analysis_runs_owner_created_idx
  ON analysis_runs(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS telegram_ai_runs_owner_created_idx
  ON telegram_ai_runs(owner_id, created_at DESC);
