-- Maintain both historical link count and currently active evidence without full-table scans.
ALTER TABLE tg_runtime_metrics
  ADD COLUMN IF NOT EXISTS links_active_total BIGINT NOT NULL DEFAULT 0
  CHECK (links_active_total >= 0);

-- Repair preexisting stale orphan flags and initialize the active counter.
UPDATE tg_message_links l SET orphaned=(m.deleted_at IS NOT NULL)
FROM tg_messages m
WHERE m.source_id=l.source_id AND m.message_id=l.message_id
  AND l.orphaned IS DISTINCT FROM (m.deleted_at IS NOT NULL);

UPDATE tg_runtime_metrics
SET links_active_total=(SELECT count(*) FROM tg_message_links WHERE orphaned=FALSE),
    updated_at=now()
WHERE id=1;

CREATE OR REPLACE FUNCTION tg_update_link_counter() RETURNS trigger
LANGUAGE plpgsql AS $counter$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE tg_runtime_metrics
    SET links_total=links_total+1,
        links_active_total=links_active_total+CASE WHEN NEW.orphaned THEN 0 ELSE 1 END,
        updated_at=now() WHERE id=1;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE tg_runtime_metrics
    SET links_total=GREATEST(0,links_total-1),
        links_active_total=GREATEST(0,links_active_total-CASE WHEN OLD.orphaned THEN 0 ELSE 1 END),
        updated_at=now() WHERE id=1;
    RETURN OLD;
  ELSIF OLD.orphaned IS DISTINCT FROM NEW.orphaned THEN
    UPDATE tg_runtime_metrics
    SET links_active_total=GREATEST(0,links_active_total+
      CASE WHEN NEW.orphaned THEN -1 ELSE 1 END),
      updated_at=now() WHERE id=1;
  END IF;
  RETURN NEW;
END
$counter$;

DO $install$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname='tg_message_links_orphan_count_trg'
      AND tgrelid='tg_message_links'::regclass AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER tg_message_links_orphan_count_trg
    AFTER UPDATE OF orphaned ON tg_message_links
    FOR EACH ROW EXECUTE FUNCTION tg_update_link_counter();
  END IF;
END
$install$;

ALTER TABLE tg_runtime
  ADD COLUMN IF NOT EXISTS links_active_total BIGINT NOT NULL DEFAULT 0;

UPDATE tg_runtime
SET links_active_total=COALESCE((SELECT links_active_total FROM tg_runtime_metrics WHERE id=1),0)
WHERE id=1;

COMMENT ON COLUMN tg_runtime.links_total IS 'Historical count of canonical evidence including soft-deleted messages.';
COMMENT ON COLUMN tg_runtime.links_active_total IS 'Canonical evidence currently active (non-orphaned), tracked by database triggers.';
