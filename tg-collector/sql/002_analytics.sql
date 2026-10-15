-- Derived evidence: one observation per (source, message, relation, target).
-- A link means "mentioned/forwarded/referenced"; NOT ownership or proof of coordination.
ALTER TABLE tg_messages ADD COLUMN IF NOT EXISTS analysis_version SMALLINT NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS tg_message_links (
  source_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('mention','forward','contract')),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('handle','channel_id','solana_contract','evm_contract')),
  target_key TEXT NOT NULL,
  PRIMARY KEY (source_id,message_id,kind,target_kind,target_key),
  FOREIGN KEY (source_id,message_id) REFERENCES tg_messages(source_id,message_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS tg_links_target_idx ON tg_message_links(target_kind,target_key,source_id);
CREATE INDEX IF NOT EXISTS tg_links_source_kind_idx ON tg_message_links(source_id,kind,target_kind);
CREATE INDEX IF NOT EXISTS tg_messages_analysis_pending_idx
  ON tg_messages(source_id,message_id) WHERE analysis_version < 1;
CREATE INDEX IF NOT EXISTS tg_messages_posted_global_idx ON tg_messages(posted_at DESC NULLS LAST,message_id DESC);
