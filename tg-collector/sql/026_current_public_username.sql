-- Preserve original source identifier for stable CLI/API configuration while tracking
-- the current public username verified from Telegram's immutable channel ID.
ALTER TABLE tg_sources ADD COLUMN IF NOT EXISTS current_username TEXT;

COMMENT ON COLUMN tg_sources.current_username IS
  'Latest public username verified from the Telegram channel entity. May differ from the original identifier after rename. NULL means not yet verified.';
