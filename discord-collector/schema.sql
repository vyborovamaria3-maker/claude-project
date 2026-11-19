-- Isolated Discord SOURCE database; do NOT apply to central Intelligence.
CREATE TABLE IF NOT EXISTS discord_messages (
 message_id TEXT PRIMARY KEY CHECK(message_id ~ '^[0-9]{15,22}$'),
 guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, author_id TEXT,
 occurred_at TIMESTAMPTZ, observed_at TIMESTAMPTZ NOT NULL,
 edited_at TIMESTAMPTZ, content TEXT, content_sha256 TEXT,
 deleted_at TIMESTAMPTZ,
 revision_at TIMESTAMPTZ
);
ALTER TABLE discord_messages ADD COLUMN IF NOT EXISTS revision_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS discord_messages_channel_time ON discord_messages(channel_id,occurred_at);
CREATE TABLE IF NOT EXISTS discord_message_revisions (
 message_id TEXT NOT NULL, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
 revision_key TEXT NOT NULL CHECK(length(revision_key)=64),
 event_kind TEXT NOT NULL CHECK(event_kind IN ('observed','edited','deleted')),
 observed_at TIMESTAMPTZ NOT NULL, content_sha256 TEXT, content TEXT,
 PRIMARY KEY(message_id,revision_key)
);
CREATE INDEX IF NOT EXISTS discord_revisions_message ON discord_message_revisions(message_id);
CREATE TABLE IF NOT EXISTS discord_backfill_cursors (
 channel_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL,
 before_message_id TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS discord_recovery_checks (
 id BIGSERIAL PRIMARY KEY,
 guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
 checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 baseline_message_id TEXT,
 status TEXT NOT NULL CHECK(status IN ('initial_unverified','bounded_recovery','gap_unresolved','failed')),
 pages_scanned INTEGER NOT NULL DEFAULT 0,
 messages_processed INTEGER NOT NULL DEFAULT 0,
 resolved_at TIMESTAMPTZ
);
ALTER TABLE discord_recovery_checks ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS discord_recovery_status ON discord_recovery_checks(channel_id,checked_at DESC);

-- Minimal source-side tombstones survive retention/revocation purges. They contain
-- identifiers and erasure metadata only, never message content or author IDs.
CREATE TABLE IF NOT EXISTS discord_message_tombstones (
 message_id TEXT PRIMARY KEY,
 guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
 deleted_at TIMESTAMPTZ NOT NULL,
 deletion_reason TEXT NOT NULL CHECK(deletion_reason IN ('deleted','retention_expired','channel_revoked','user_requested')),
 CHECK (
  message_id ~ '^[1-9][0-9]{14,21}$'
  AND guild_id ~ '^[1-9][0-9]{14,21}$'
  AND channel_id ~ '^[1-9][0-9]{14,21}$'
  AND message_id::numeric <= 18446744073709551615
  AND guild_id::numeric <= 18446744073709551615
  AND channel_id::numeric <= 18446744073709551615
 )
);
CREATE INDEX IF NOT EXISTS discord_tombstones_channel_time
 ON discord_message_tombstones(channel_id,deleted_at);

-- Application code validates before writes; database constraints provide a
-- second boundary against malformed/non-uint64 identifiers.
DO $discord_snowflake_constraints$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='discord_messages'::regclass AND conname='discord_messages_snowflake_ids_check') THEN
  ALTER TABLE discord_messages ADD CONSTRAINT discord_messages_snowflake_ids_check CHECK (
   CASE WHEN message_id ~ '^[1-9][0-9]{14,21}$' AND guild_id ~ '^[1-9][0-9]{14,21}$' AND channel_id ~ '^[1-9][0-9]{14,21}$'
   THEN message_id::numeric <= 18446744073709551615 AND guild_id::numeric <= 18446744073709551615 AND channel_id::numeric <= 18446744073709551615
   ELSE false END
  ) NOT VALID;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='discord_message_revisions'::regclass AND conname='discord_message_revisions_snowflake_ids_check') THEN
  ALTER TABLE discord_message_revisions ADD CONSTRAINT discord_message_revisions_snowflake_ids_check CHECK (
   CASE WHEN message_id ~ '^[1-9][0-9]{14,21}$' AND guild_id ~ '^[1-9][0-9]{14,21}$' AND channel_id ~ '^[1-9][0-9]{14,21}$'
   THEN message_id::numeric <= 18446744073709551615 AND guild_id::numeric <= 18446744073709551615 AND channel_id::numeric <= 18446744073709551615
   ELSE false END
  ) NOT VALID;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='discord_backfill_cursors'::regclass AND conname='discord_backfill_cursors_snowflake_ids_check') THEN
  ALTER TABLE discord_backfill_cursors ADD CONSTRAINT discord_backfill_cursors_snowflake_ids_check CHECK (
   CASE WHEN channel_id ~ '^[1-9][0-9]{14,21}$' AND guild_id ~ '^[1-9][0-9]{14,21}$' AND before_message_id ~ '^[1-9][0-9]{14,21}$'
   THEN channel_id::numeric <= 18446744073709551615 AND guild_id::numeric <= 18446744073709551615 AND before_message_id::numeric <= 18446744073709551615
   ELSE false END
  ) NOT VALID;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='discord_recovery_checks'::regclass AND conname='discord_recovery_checks_snowflake_ids_check') THEN
  ALTER TABLE discord_recovery_checks ADD CONSTRAINT discord_recovery_checks_snowflake_ids_check CHECK (
   CASE WHEN guild_id ~ '^[1-9][0-9]{14,21}$' AND channel_id ~ '^[1-9][0-9]{14,21}$'
   THEN guild_id::numeric <= 18446744073709551615 AND channel_id::numeric <= 18446744073709551615
    AND (baseline_message_id IS NULL OR CASE WHEN baseline_message_id ~ '^[1-9][0-9]{14,21}$' THEN baseline_message_id::numeric <= 18446744073709551615 ELSE false END)
   ELSE false END
  ) NOT VALID;
 END IF;
END;
$discord_snowflake_constraints$;

ALTER TABLE discord_messages VALIDATE CONSTRAINT discord_messages_snowflake_ids_check;
ALTER TABLE discord_message_revisions VALIDATE CONSTRAINT discord_message_revisions_snowflake_ids_check;
ALTER TABLE discord_backfill_cursors VALIDATE CONSTRAINT discord_backfill_cursors_snowflake_ids_check;
ALTER TABLE discord_recovery_checks VALIDATE CONSTRAINT discord_recovery_checks_snowflake_ids_check;

-- Content-free per-message coverage failures are durable before an unhydratable
-- spool event is acknowledged. They are bounded by the same channel retention.
CREATE TABLE IF NOT EXISTS discord_coverage_failures (
 id BIGSERIAL PRIMARY KEY,
 guild_id TEXT NOT NULL,
 channel_id TEXT NOT NULL,
 message_id TEXT NOT NULL,
 author_id TEXT,
 event_kind TEXT NOT NULL CHECK(event_kind IN ('observed','edited','deleted')),
 received_at TIMESTAMPTZ NOT NULL,
 failure_code TEXT NOT NULL CHECK(failure_code IN ('message_not_found')),
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 expires_at TIMESTAMPTZ NOT NULL,
 UNIQUE(guild_id,channel_id,message_id,event_kind,received_at),
 CHECK (
  guild_id ~ '^[1-9][0-9]{14,21}$'
  AND channel_id ~ '^[1-9][0-9]{14,21}$'
  AND message_id ~ '^[1-9][0-9]{14,21}$'
  AND (author_id IS NULL OR author_id ~ '^[1-9][0-9]{14,21}$')
 )
);
CREATE INDEX IF NOT EXISTS discord_coverage_failures_channel_expiry
 ON discord_coverage_failures(channel_id,expires_at);
CREATE INDEX IF NOT EXISTS discord_coverage_failures_author
 ON discord_coverage_failures(author_id) WHERE author_id IS NOT NULL;
