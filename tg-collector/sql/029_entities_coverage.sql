-- NULL means the old archived message never captured Telegram entities; [] is a
-- verified empty Telegram entities array for a newly fetched message.
ALTER TABLE tg_messages
  ADD COLUMN IF NOT EXISTS entities_observed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS entities_refetch_attempted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS tg_messages_missing_entities_idx
ON tg_messages(source_id,message_id)
WHERE entities_observed_at IS NULL AND deleted_at IS NULL;

COMMENT ON COLUMN tg_messages.entities_observed_at IS
  'When Telegram entities were actually fetched (even if the entities array was empty). NULL means historical evidence may be incomplete.';
