-- Additive indices to keep encrypted text revocations bounded to one
-- evidence ID even when the event inbox contains millions of source rows.
CREATE INDEX IF NOT EXISTS idx_intelligence_inbox_evidence_source
  ON intelligence_inbox(source_system,evidence_source_id,ingested_at DESC);
CREATE INDEX IF NOT EXISTS idx_text_snapshots_unpurged_source
  ON event_text_snapshots(source_system,source_event_kind,event_key)
  WHERE purged_at IS NULL;
