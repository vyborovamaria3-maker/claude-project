-- Account-level restriction is not a retryable per-source failure.
ALTER TABLE tg_runtime ADD COLUMN IF NOT EXISTS block_reason TEXT;
ALTER TABLE tg_runtime ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ;
