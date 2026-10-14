-- Persist cursor no-progress streak across task/worker restarts.
-- Historical HTTP checkpoints created by migration 041 start at zero.
ALTER TABLE xc_http_checkpoints
  ADD COLUMN IF NOT EXISTS consecutive_empty_pages integer NOT NULL DEFAULT 0
  CHECK (consecutive_empty_pages >= 0);
