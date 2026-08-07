-- v3.2.0 performance layer. All tables are additive and can be migrated into
-- another PostgreSQL project without adopting a specific ORM.
CREATE TABLE IF NOT EXISTS post_features (
  post_id text NOT NULL,
  post_created_at timestamptz NOT NULL,
  contracts text[] NOT NULL DEFAULT '{}',
  links text[] NOT NULL DEFAULT '{}',
  mentions text[] NOT NULL DEFAULT '{}',
  hashtags text[] NOT NULL DEFAULT '{}',
  tickers text[] NOT NULL DEFAULT '{}',
  words text[] NOT NULL DEFAULT '{}',
  normalized_text text NOT NULL DEFAULT '',
  text_fingerprint text NOT NULL,
  language text,
  sentiment real,
  embedding real[],
  feature_version smallint NOT NULL DEFAULT 1,
  extracted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(post_id, post_created_at),
  FOREIGN KEY(post_id, post_created_at) REFERENCES x_posts(id, created_at) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS post_features_contracts_gin ON post_features USING gin(contracts);
CREATE INDEX IF NOT EXISTS post_features_links_gin ON post_features USING gin(links);
CREATE INDEX IF NOT EXISTS post_features_mentions_gin ON post_features USING gin(mentions);
CREATE INDEX IF NOT EXISTS post_features_hashtags_gin ON post_features USING gin(hashtags);
CREATE INDEX IF NOT EXISTS post_features_tickers_gin ON post_features USING gin(tickers);
CREATE INDEX IF NOT EXISTS post_features_words_gin ON post_features USING gin(words);
CREATE INDEX IF NOT EXISTS post_features_fingerprint_idx ON post_features(text_fingerprint, post_created_at DESC);
CREATE INDEX IF NOT EXISTS post_features_extracted_brin ON post_features USING brin(extracted_at);

CREATE TABLE IF NOT EXISTS analysis_metrics (
  id bigserial PRIMARY KEY,
  analysis_run_id uuid REFERENCES analysis_runs(id) ON DELETE CASCADE,
  stage text NOT NULL,
  duration_ms double precision NOT NULL,
  rows_in bigint NOT NULL DEFAULT 0,
  rows_out bigint NOT NULL DEFAULT 0,
  memory_bytes bigint,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS analysis_metrics_run_stage_idx ON analysis_metrics(analysis_run_id, stage, recorded_at DESC);
CREATE INDEX IF NOT EXISTS analysis_metrics_recorded_brin ON analysis_metrics USING brin(recorded_at);

CREATE TABLE IF NOT EXISTS token_analysis_cache (
  token_id uuid NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  analysis_version text NOT NULL,
  provider text NOT NULL,
  input_hash text NOT NULL,
  result jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(token_id, analysis_version, provider, input_hash)
);
CREATE INDEX IF NOT EXISTS token_analysis_cache_expiry_idx ON token_analysis_cache(expires_at);

CREATE MATERIALIZED VIEW IF NOT EXISTS account_feature_summary AS
WITH base AS (
  SELECT p.author_id, p.created_at, f.contracts, f.links, f.tickers, f.hashtags
  FROM x_posts p
  JOIN post_features f ON f.post_id=p.id AND f.post_created_at=p.created_at
),
stats AS (
  SELECT author_id, count(*)::bigint AS analyzed_posts, min(created_at) AS first_post_at, max(created_at) AS last_post_at
  FROM base GROUP BY author_id
),
contracts AS (
  SELECT author_id, array_agg(DISTINCT value) AS values FROM base CROSS JOIN LATERAL unnest(contracts) value GROUP BY author_id
),
links AS (
  SELECT author_id, array_agg(DISTINCT value) AS values FROM base CROSS JOIN LATERAL unnest(links) value GROUP BY author_id
),
tickers AS (
  SELECT author_id, array_agg(DISTINCT value) AS values FROM base CROSS JOIN LATERAL unnest(tickers) value GROUP BY author_id
),
hashtags AS (
  SELECT author_id, array_agg(DISTINCT value) AS values FROM base CROSS JOIN LATERAL unnest(hashtags) value GROUP BY author_id
)
SELECT s.author_id,s.analyzed_posts,s.first_post_at,s.last_post_at,
  COALESCE(c.values,'{}') AS contracts,COALESCE(l.values,'{}') AS links,
  COALESCE(t.values,'{}') AS tickers,COALESCE(h.values,'{}') AS hashtags
FROM stats s
LEFT JOIN contracts c USING(author_id)
LEFT JOIN links l USING(author_id)
LEFT JOIN tickers t USING(author_id)
LEFT JOIN hashtags h USING(author_id)
WITH NO DATA;
CREATE UNIQUE INDEX IF NOT EXISTS account_feature_summary_author_uidx ON account_feature_summary(author_id);

CREATE INDEX IF NOT EXISTS token_snapshots_token_captured_idx ON token_snapshots(token_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS analysis_runs_status_created_idx ON analysis_runs(status, created_at);
