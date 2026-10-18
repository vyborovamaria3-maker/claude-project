-- Substring matching on message text otherwise degrades to a full scan on large history.
-- pg_trgm is a trusted PostgreSQL extension on modern PostgreSQL versions.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS tg_messages_text_trgm_idx
  ON tg_messages USING GIN (text gin_trgm_ops);
