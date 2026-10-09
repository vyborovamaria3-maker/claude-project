CREATE TABLE social_agent_commands (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('run','discover')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','failed')),
  created_at BIGINT NOT NULL,
  completed_at BIGINT,
  result JSONB,
  error TEXT
);
CREATE UNIQUE INDEX social_agent_one_pending ON social_agent_commands(kind) WHERE status='pending';
