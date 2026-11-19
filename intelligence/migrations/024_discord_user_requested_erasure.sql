-- Extend the durable Discord tombstone reason set for explicit user requests.
-- Migration 023 creates the original check; this additive migration preserves
-- already-applied migration history.
ALTER TABLE discord_message_tombstones
  DROP CONSTRAINT IF EXISTS discord_message_tombstones_deletion_reason_check;

ALTER TABLE discord_message_tombstones
  ADD CONSTRAINT discord_message_tombstones_deletion_reason_check
  CHECK (deletion_reason IN ('deleted','retention_expired','channel_revoked','user_requested'))
  NOT VALID;

ALTER TABLE discord_message_tombstones
  VALIDATE CONSTRAINT discord_message_tombstones_deletion_reason_check;

COMMENT ON COLUMN discord_message_tombstones.deletion_reason IS
  'Reason for source erasure: message delete, retention expiry, channel revocation, or user-requested erasure.';
