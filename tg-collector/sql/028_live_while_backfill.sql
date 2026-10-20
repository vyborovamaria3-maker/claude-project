-- Independent checkpoint for new messages while old full-history backfill runs.
ALTER TABLE tg_jobs
  ADD COLUMN IF NOT EXISTS fresh_base_message_id BIGINT,
  ADD COLUMN IF NOT EXISTS fresh_high_message_id BIGINT,
  ADD COLUMN IF NOT EXISTS fresh_cursor_before_id BIGINT;

ALTER TABLE tg_sources
  ADD COLUMN IF NOT EXISTS live_checked_at TIMESTAMPTZ;

COMMENT ON COLUMN tg_jobs.fresh_cursor_before_id IS
  'Resumable newest-to-oldest incremental scan; independent of older history cursor.';
COMMENT ON COLUMN tg_sources.live_checked_at IS
  'Last check for newly published posts during a full historical backfill.';
