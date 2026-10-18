-- Evidence lifecycle, analysis versioning, runtime metrics and soft-delete.
-- Partitioning is intentionally deferred: tg_messages is referenced by the canonical
-- tg_message_links key (source_id,message_id). A safe monthly partition migration
-- requires a key/FK redesign and must be done as a dedicated, rehearsed migration.

ALTER TABLE tg_messages
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE tg_messages
  ALTER COLUMN analysis_version SET DEFAULT 1;

ALTER TABLE tg_message_links
  ADD COLUMN IF NOT EXISTS analysis_version SMALLINT NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_tg_message_links_analysis_version
  ON tg_message_links(analysis_version);

CREATE INDEX IF NOT EXISTS idx_tg_messages_active_posted_at
  ON tg_messages(source_id, posted_at DESC)
  WHERE deleted_at IS NULL;

ALTER TABLE tg_graph_daily_edges
  ADD COLUMN IF NOT EXISTS message_count INTEGER NOT NULL DEFAULT 0;

UPDATE tg_graph_daily_edges
SET message_count = evidence_count
WHERE message_count = 0 AND evidence_count > 0;

CREATE TABLE IF NOT EXISTS tg_runtime_metrics (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  links_total BIGINT NOT NULL DEFAULT 0 CHECK (links_total >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO tg_runtime_metrics(id, links_total)
VALUES (1, (SELECT count(*)::bigint FROM tg_message_links))
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION tg_update_link_counter() RETURNS trigger
LANGUAGE plpgsql AS $counter$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE tg_runtime_metrics
    SET links_total = links_total + 1, updated_at = now()
    WHERE id = 1;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE tg_runtime_metrics
    SET links_total = GREATEST(0, links_total - 1), updated_at = now()
    WHERE id = 1;
    RETURN OLD;
  END IF;
  RETURN NULL;
END
$counter$;

DO $install$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname='tg_message_links_count_trg'
      AND tgrelid='tg_message_links'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER tg_message_links_count_trg
    AFTER INSERT OR DELETE ON tg_message_links
    FOR EACH ROW EXECUTE FUNCTION tg_update_link_counter();
  END IF;
END
$install$;

CREATE OR REPLACE FUNCTION tg_update_message_counter_on_soft_delete() RETURNS trigger
LANGUAGE plpgsql AS $counter$
BEGIN
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    UPDATE tg_source_message_counters
    SET message_count = GREATEST(0, message_count - 1)
    WHERE source_id = NEW.source_id;
  ELSIF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
    INSERT INTO tg_source_message_counters(source_id,message_count)
    VALUES (NEW.source_id,1)
    ON CONFLICT (source_id) DO UPDATE SET
      message_count=tg_source_message_counters.message_count+1;
  END IF;
  RETURN NEW;
END
$counter$;

DO $install$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname='tg_messages_soft_delete_count_trg'
      AND tgrelid='tg_messages'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER tg_messages_soft_delete_count_trg
    AFTER UPDATE OF deleted_at ON tg_messages
    FOR EACH ROW EXECUTE FUNCTION tg_update_message_counter_on_soft_delete();
  END IF;
END
$install$;

ALTER TABLE tg_runtime
  ADD COLUMN IF NOT EXISTS messages_total BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS messages_per_day BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS links_total BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS links_per_day BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS jobs_pending INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS jobs_failed INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS flood_wait_active BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS metrics_updated_at TIMESTAMPTZ;

UPDATE tg_runtime
SET messages_total = COALESCE((SELECT sum(message_count) FROM tg_source_message_counters),0),
    links_total = COALESCE((SELECT links_total FROM tg_runtime_metrics WHERE id=1),0),
    metrics_updated_at = now()
WHERE id=1;

COMMENT ON COLUMN tg_message_links.analysis_version IS
  'Extractor version that produced this observed fact. Preserved evidence keeps its original version.';
COMMENT ON COLUMN tg_graph_daily_edges.evidence_count IS
  'Count of canonical tg_message_links rows for the day; each row represents one unique source/message/target fact.';
COMMENT ON COLUMN tg_graph_daily_edges.message_count IS
  'Count of distinct source messages supporting the edge in the day. With canonical link uniqueness this equals evidence_count.';
COMMENT ON COLUMN tg_messages.deleted_at IS
  'Soft-delete marker. Historical evidence remains in tg_message_links; deleted messages are excluded from active analytics.';
