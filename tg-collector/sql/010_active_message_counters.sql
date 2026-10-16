-- Hard-deleting an already soft-deleted row must not decrement an active count twice.
CREATE OR REPLACE FUNCTION tg_update_message_counter() RETURNS trigger
LANGUAGE plpgsql AS $counter$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.deleted_at IS NULL THEN
      INSERT INTO tg_source_message_counters(source_id,message_count)
      VALUES(NEW.source_id,1)
      ON CONFLICT (source_id) DO UPDATE SET
        message_count=tg_source_message_counters.message_count+1;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.deleted_at IS NULL THEN
      UPDATE tg_source_message_counters SET message_count=message_count-1
      WHERE source_id=OLD.source_id AND message_count > 0;
    END IF;
    RETURN OLD;
  END IF;
  RETURN NULL;
END
$counter$;

-- Repair existing counts once; subsequent startup migrations do not scan message history.
ALTER TABLE tg_runtime ADD COLUMN IF NOT EXISTS active_counters_initialized BOOLEAN NOT NULL DEFAULT FALSE;
DO $repair$
BEGIN
  IF EXISTS (SELECT 1 FROM tg_runtime WHERE id=1 AND NOT active_counters_initialized) THEN
    INSERT INTO tg_source_message_counters(source_id,message_count)
    SELECT s.id, count(m.message_id)::bigint
    FROM tg_sources s LEFT JOIN tg_messages m ON m.source_id=s.id AND m.deleted_at IS NULL
    GROUP BY s.id
    ON CONFLICT(source_id) DO UPDATE SET message_count=EXCLUDED.message_count;
    UPDATE tg_runtime SET active_counters_initialized=TRUE WHERE id=1;
  END IF;
END
$repair$;
