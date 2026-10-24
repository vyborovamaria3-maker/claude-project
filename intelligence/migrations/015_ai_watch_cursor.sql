-- Destination-only cursor for read-only Telegram watching; never alter collector schemas.
CREATE TABLE IF NOT EXISTS ai_source_watch_cursors (
 source_identity TEXT PRIMARY KEY CHECK(source_identity ~ '^[a-f0-9]{64}$'),
 observed_at TIMESTAMPTZ NOT NULL,
 source_id BIGINT NOT NULL CHECK(source_id>=0),
 message_id BIGINT NOT NULL CHECK(message_id>=0),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
