-- Thread context and versioned narrative evidence.
ALTER TABLE tg_messages ADD COLUMN IF NOT EXISTS reply_to_message_id BIGINT;
CREATE INDEX IF NOT EXISTS tg_messages_reply_idx
  ON tg_messages(source_id,reply_to_message_id) WHERE reply_to_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS tg_message_threads (
  source_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  reply_to_message_id BIGINT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(source_id,message_id),
  CHECK(reply_to_message_id <> message_id),
  FOREIGN KEY(source_id,message_id) REFERENCES tg_messages(source_id,message_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS tg_message_threads_parent_idx
  ON tg_message_threads(source_id,reply_to_message_id);

ALTER TABLE tg_coordination_events ADD COLUMN IF NOT EXISTS cluster_id BIGINT
  REFERENCES tg_copy_clusters(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tg_coordination_cluster_unique_idx
  ON tg_coordination_events(chain_id,mint,cluster_id,window_start,model_version)
  WHERE cluster_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS tg_message_narratives (
  source_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  chain_id TEXT NOT NULL,
  mint TEXT NOT NULL,
  narrative_id BIGINT NOT NULL REFERENCES tg_narratives(id) ON DELETE CASCADE,
  confidence NUMERIC(5,4) NOT NULL CHECK(confidence BETWEEN 0 AND 1),
  evidence_terms TEXT[] NOT NULL DEFAULT '{}',
  model_version TEXT NOT NULL,
  analyzed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(source_id,message_id,chain_id,mint,narrative_id,model_version),
  FOREIGN KEY(source_id,message_id) REFERENCES tg_messages(source_id,message_id) ON DELETE CASCADE,
  FOREIGN KEY(chain_id,mint) REFERENCES tg_tokens(chain_id,mint) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS tg_message_narratives_token_idx
  ON tg_message_narratives(chain_id,mint,model_version,analyzed_at DESC);

INSERT INTO tg_narratives(narrative_name,description,rules,model_version) VALUES
  ('frog','Frog and Pepe-related meme narrative','{"keywords":["frog","pepe","ribbit","feels good man"]}'::jsonb,'keyword-v1'),
  ('cat','Cat-themed meme narrative','{"keywords":["cat","kitty","meow","feline"]}'::jsonb,'keyword-v1'),
  ('dog','Dog-themed meme narrative','{"keywords":["doge","shiba","puppy","dog coin"]}'::jsonb,'keyword-v1'),
  ('ai_agent','AI and agent narrative','{"keywords":["ai agent","ai-agent","agentic","llm","autonomous agent"]}'::jsonb,'keyword-v1'),
  ('politics_us','US political narrative','{"keywords":["trump","maga","election","biden"]}'::jsonb,'keyword-v1'),
  ('gaming','Gaming-related narrative','{"keywords":["gaming","gamefi","cs2","steam game"]}'::jsonb,'keyword-v1'),
  ('defi','DeFi and on-chain finance narrative','{"keywords":["defi","yield","staking","liquidity pool"]}'::jsonb,'keyword-v1'),
  ('celebrity','Celebrity and influencer narrative','{"keywords":["celebrity","influencer","viral star"]}'::jsonb,'keyword-v1'),
  ('animal_meme','Other animal meme narrative','{"keywords":["bear","bull","frog","cat","dog","penguin","monkey"]}'::jsonb,'keyword-v1')
ON CONFLICT(narrative_name) DO UPDATE SET
  description=EXCLUDED.description,rules=EXCLUDED.rules,model_version=EXCLUDED.model_version;

COMMENT ON TABLE tg_message_threads IS
  'Reply edges from a message to its parent message within a collected source. Missing parent messages are allowed.';
COMMENT ON TABLE tg_message_narratives IS
  'Versioned keyword-derived narrative evidence; a label is classification, not proof of token purpose.';
COMMENT ON TABLE tg_coordination_events IS
  'Cross-source identical-copy patterns requiring review; these records do not establish coordinated behavior.';
