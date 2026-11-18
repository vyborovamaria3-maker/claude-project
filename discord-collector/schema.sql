-- Isolated Discord SOURCE database; do NOT apply to central Intelligence.
CREATE TABLE IF NOT EXISTS discord_messages (
 message_id TEXT PRIMARY KEY CHECK(message_id ~ '^[0-9]{15,22}$'),
 guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, author_id TEXT,
 occurred_at TIMESTAMPTZ, observed_at TIMESTAMPTZ NOT NULL,
 edited_at TIMESTAMPTZ, content TEXT, content_sha256 TEXT,
 deleted_at TIMESTAMPTZ,
 revision_at TIMESTAMPTZ
);
-- Additive upgrade for experimental databases created by foundation PR #220.
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
