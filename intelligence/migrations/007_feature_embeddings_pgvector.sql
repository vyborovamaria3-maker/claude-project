-- Optional migration: requires pgvector installed on the PostgreSQL server.
-- Apply only after 006_cross_platform_analytics.sql and confirming pgvector support.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS feature_embeddings (
  entity_id TEXT NOT NULL,
  feature_version TEXT NOT NULL,
  as_of TIMESTAMPTZ NOT NULL,
  max_input_observed_at TIMESTAMPTZ NOT NULL,
  model_id TEXT NOT NULL REFERENCES model_registry(model_id),
  embedding vector(1024) NOT NULL,
  embedding_sha256 TEXT NOT NULL CHECK (embedding_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(entity_id,feature_version,as_of),
  CHECK (max_input_observed_at <= as_of)
);
CREATE INDEX IF NOT EXISTS idx_feature_embeddings_hnsw
  ON feature_embeddings USING hnsw (embedding vector_cosine_ops);
