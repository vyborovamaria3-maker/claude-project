-- Coalesce revisions of the same source evidence and paginate historical recomputation.
-- Destination Intelligence database only; apply after 010 and 013.
ALTER TABLE analytics_invalidation_queue
  ADD COLUMN IF NOT EXISTS coalesce_key TEXT;
UPDATE analytics_invalidation_queue
  SET coalesce_key=event_key
  WHERE coalesce_key IS NULL;
ALTER TABLE analytics_invalidation_queue
  ALTER COLUMN coalesce_key SET NOT NULL;
ALTER TABLE analytics_invalidation_queue
  ADD COLUMN IF NOT EXISTS next_day DATE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='analytics_invalidation_queue'::regclass
      AND conname='analytics_invalidation_coalesce_key_length'
  ) THEN
    ALTER TABLE analytics_invalidation_queue
      ADD CONSTRAINT analytics_invalidation_coalesce_key_length
      CHECK(length(coalesce_key) BETWEEN 1 AND 512);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_analytics_invalidation_coalesced
  ON analytics_invalidation_queue(canonical_token_id,source_system,event_kind,coalesce_key,reason);
CREATE INDEX IF NOT EXISTS idx_invalidation_cursor
  ON analytics_invalidation_queue(status,next_day,next_attempt_at,invalidation_id);
