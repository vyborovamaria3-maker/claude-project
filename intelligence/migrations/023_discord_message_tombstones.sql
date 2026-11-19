-- Durable destination-side Discord deletion state.
-- The row survives evidence/timeline erasure so late or replayed source events
-- cannot resurrect a deleted, expired, or revoked message.
CREATE TABLE IF NOT EXISTS discord_message_tombstones (
  evidence_source_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL,
  deletion_reason TEXT NOT NULL CHECK (
    deletion_reason IN ('deleted','retention_expired','channel_revoked')
  ),
  deletion_event_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT discord_message_tombstones_identity_check CHECK (
    evidence_source_id = 'discord:message:' || channel_id || ':' || message_id
    AND channel_id ~ '^[1-9][0-9]{14,21}$'
    AND message_id ~ '^[1-9][0-9]{14,21}$'
    AND CASE
      WHEN channel_id ~ '^[1-9][0-9]{14,21}$'
       AND message_id ~ '^[1-9][0-9]{14,21}$'
      THEN channel_id::numeric <= 18446744073709551615
       AND message_id::numeric <= 18446744073709551615
      ELSE false
    END
  )
);

CREATE INDEX IF NOT EXISTS idx_discord_message_tombstones_channel
  ON discord_message_tombstones(channel_id, deleted_at);

COMMENT ON TABLE discord_message_tombstones IS
  'Minimal durable tombstones: no message body, author ID, or content fingerprint. Prevents late Discord event replay from recreating erased evidence.';
