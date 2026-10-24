-- Retry scheduling for Intelligence invalidations. Apply AFTER governance 010.
-- A failed job may only be claimed after an exponential delay.
ALTER TABLE analytics_invalidation_queue
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp();
CREATE INDEX IF NOT EXISTS idx_invalidation_next_attempt
  ON analytics_invalidation_queue(status,next_attempt_at,queued_at,invalidation_id);
