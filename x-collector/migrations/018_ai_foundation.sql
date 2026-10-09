-- Additive history for reproducible AI input. No historical versions are invented.
CREATE TABLE IF NOT EXISTS archive_post_versions (
 post_id text NOT NULL REFERENCES archive_posts ON DELETE CASCADE,
 source_id text NOT NULL REFERENCES archive_sources,
 raw_hash text NOT NULL, received_at timestamptz NOT NULL,
 text text NOT NULL, posted_at timestamptz NOT NULL,
 author_id text, author_handle text, lang text,
 PRIMARY KEY(post_id,source_id,raw_hash)
);
CREATE INDEX IF NOT EXISTS archive_versions_asof ON archive_post_versions(post_id,received_at DESC,source_id,raw_hash);
CREATE INDEX IF NOT EXISTS archive_posts_received ON archive_posts(first_received_at,id);
CREATE INDEX IF NOT EXISTS archive_metrics_asof ON archive_metrics(post_id,metrics_observed_at DESC,received_at DESC);
CREATE TABLE IF NOT EXISTS ai_models (
 name text NOT NULL, version text NOT NULL, task text NOT NULL,
 dimensions integer CHECK(dimensions BETWEEN 1 AND 8192),
 metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(name,version)
);
CREATE TABLE IF NOT EXISTS ai_post_results (
 post_id text NOT NULL, source_id text NOT NULL, raw_hash text NOT NULL,
 model_name text NOT NULL, model_version text NOT NULL,
 input_hash text NOT NULL CHECK(length(input_hash)=64),
 result jsonb NOT NULL, embedding double precision[], dimensions integer,
 generated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(post_id,source_id,raw_hash,model_name,model_version),
 FOREIGN KEY(post_id,source_id,raw_hash) REFERENCES archive_post_versions ON DELETE CASCADE,
 FOREIGN KEY(model_name,model_version) REFERENCES ai_models,
 CHECK((embedding IS NULL AND dimensions IS NULL) OR
       (embedding IS NOT NULL AND dimensions IS NOT NULL AND cardinality(embedding)=dimensions AND dimensions BETWEEN 1 AND 8192))
);
CREATE INDEX IF NOT EXISTS ai_results_model ON ai_post_results(model_name,model_version,generated_at);
