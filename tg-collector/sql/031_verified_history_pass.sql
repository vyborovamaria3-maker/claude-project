-- Complete history must mean a verified full scan began at Telegram's
-- newest accessible post. A delayed recent-only job may be converted to
-- full_history=true mid-flight; completing its old interval is NOT proof.
ALTER TABLE tg_jobs
  ADD COLUMN IF NOT EXISTS history_scan_verified BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN tg_jobs.history_scan_verified IS
  'TRUE only after a full-history worker began scanning from Telegram head. Reset on job completion. Existing partial/recent jobs never authorize history_complete.';

-- Previously persisted history_complete flags may have been inferred from an
-- isolated minimum observed message ID. Conservatively require a new verified
-- full pass to re-establish completeness; no messages or cursors are deleted.
UPDATE tg_sources
SET history_complete=FALSE,history_partial=TRUE
WHERE full_history=TRUE AND history_complete=TRUE;
