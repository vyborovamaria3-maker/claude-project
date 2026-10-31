-- Add covering/index-only paths for recurring read-only Intelligence health probes.
-- Migration 015 is checksum-protected and remains unchanged.
CREATE INDEX IF NOT EXISTS outbox_pending_health_idx
  ON outbox_events(created_at,event_kind,schema_version)
  INCLUDE (next_attempt_at,lease_until,attempts)
  WHERE processed_at IS NULL AND dead_lettered_at IS NULL;

CREATE INDEX IF NOT EXISTS outbox_dead_lettered_at_idx
  ON outbox_events(dead_lettered_at)
  WHERE dead_lettered_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS outbox_processed_at_desc_idx
  ON outbox_events(processed_at DESC)
  WHERE processed_at IS NOT NULL;
