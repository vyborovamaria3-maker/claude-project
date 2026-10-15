-- UTC-daily aggregated edges for bounded graph requests.
-- Rebuilt for affected UTC dates after each message batch; source evidence remains canonical.
CREATE TABLE IF NOT EXISTS tg_graph_daily_edges (
  source_id BIGINT NOT NULL REFERENCES tg_sources(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('mention','forward','address')),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('handle','channel_id','solana_address','evm_address')),
  target_key TEXT NOT NULL,
  evidence_count INTEGER NOT NULL CHECK(evidence_count > 0),
  last_seen TIMESTAMPTZ,
  sample_message_id BIGINT NOT NULL,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(source_id,day,kind,target_kind,target_key)
);
CREATE INDEX IF NOT EXISTS tg_graph_daily_target_idx
  ON tg_graph_daily_edges(target_kind,target_key,day,source_id);
CREATE INDEX IF NOT EXISTS tg_graph_daily_time_idx
  ON tg_graph_daily_edges(day DESC,source_id);
DROP INDEX IF EXISTS tg_messages_analysis_pending_idx;
CREATE INDEX IF NOT EXISTS tg_messages_analysis_pending_idx
  ON tg_messages(source_id,message_id) WHERE analysis_version < 2;
