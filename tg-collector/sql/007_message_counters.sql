-- Exact per-source message counts without scanning tg_messages on every UI poll.
CREATE TABLE IF NOT EXISTS tg_source_message_counters (
  source_id BIGINT PRIMARY KEY REFERENCES tg_sources(id) ON DELETE CASCADE,
  message_count BIGINT NOT NULL DEFAULT 0 CHECK(message_count >= 0)
);
CREATE OR REPLACE FUNCTION tg_update_message_counter() RETURNS trigger
LANGUAGE plpgsql AS $counter$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO tg_source_message_counters(source_id,message_count)
    VALUES(NEW.source_id,1)
    ON CONFLICT (source_id) DO UPDATE SET
      message_count=tg_source_message_counters.message_count+1;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE tg_source_message_counters SET message_count=message_count-1
    WHERE source_id=OLD.source_id AND message_count > 0;
    RETURN OLD;
  END IF;
  RETURN NULL;
END
$counter$;
DROP TRIGGER IF EXISTS tg_messages_count_trg ON tg_messages;
CREATE TRIGGER tg_messages_count_trg
AFTER INSERT OR DELETE ON tg_messages FOR EACH ROW EXECUTE FUNCTION tg_update_message_counter();

-- One-time reconciliation on existing databases; do not rescan millions on every startup.
ALTER TABLE tg_runtime ADD COLUMN IF NOT EXISTS counters_initialized BOOLEAN NOT NULL DEFAULT FALSE;
DO $init$
BEGIN
  IF EXISTS (SELECT 1 FROM tg_runtime WHERE id=1 AND NOT counters_initialized) THEN
    INSERT INTO tg_source_message_counters(source_id,message_count)
    SELECT s.id, count(m.message_id)::bigint
    FROM tg_sources s LEFT JOIN tg_messages m ON m.source_id=s.id
    GROUP BY s.id
    ON CONFLICT(source_id) DO UPDATE SET message_count=EXCLUDED.message_count;
    UPDATE tg_runtime SET counters_initialized=TRUE WHERE id=1;
  END IF;
END
$init$;
