CREATE TABLE graph_signal_history (
  entity TEXT NOT NULL,
  bucket_at BIGINT NOT NULL,
  window_ms BIGINT NOT NULL CHECK (window_ms > 0),
  score NUMERIC(5,2) NOT NULL CHECK (score BETWEEN 0 AND 100),
  level TEXT NOT NULL CHECK (level IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  payload JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (entity, bucket_at, window_ms)
);
CREATE INDEX graph_signal_history_recent ON graph_signal_history(bucket_at DESC, score DESC);
CREATE TABLE graph_priority_events (
  id BIGSERIAL PRIMARY KEY,
  entity TEXT NOT NULL,
  bucket_at BIGINT NOT NULL,
  window_ms BIGINT NOT NULL,
  priority INTEGER NOT NULL CHECK (priority IN (2,3)),
  payload JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(entity, bucket_at, window_ms),
  FOREIGN KEY (entity, bucket_at, window_ms) REFERENCES graph_signal_history(entity, bucket_at, window_ms) ON DELETE CASCADE
);
CREATE INDEX graph_priority_events_queue ON graph_priority_events(priority DESC, created_at DESC);
