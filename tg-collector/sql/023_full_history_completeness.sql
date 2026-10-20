-- Additive history checkpoint and Telegram evidence metadata; existing data is preserved.
ALTER TABLE tg_sources
  ADD COLUMN IF NOT EXISTS history_low_message_id BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS access_hash TEXT;

-- Existing partial histories may already have collected their first 500 messages.
-- Begin any future historical backfill below the oldest stored message.
UPDATE tg_sources s
SET history_low_message_id = oldest.low_id
FROM (
  SELECT source_id, min(message_id) AS low_id
  FROM tg_messages GROUP BY source_id
) oldest
WHERE oldest.source_id=s.id AND s.history_low_message_id=0;

ALTER TABLE tg_messages
  ADD COLUMN IF NOT EXISTS entities JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS media_type TEXT,
  ADD COLUMN IF NOT EXISTS forward_from_name TEXT,
  ADD COLUMN IF NOT EXISTS forward_date TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS forward_message_id BIGINT;
