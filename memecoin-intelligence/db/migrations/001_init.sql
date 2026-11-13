CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain text NOT NULL DEFAULT 'solana',
  mint_address text NOT NULL,
  symbol text NOT NULL,
  name text,
  description text,
  image_uri text,
  website_url text,
  x_url text,
  x_link_kind text,
  community_url text,
  creator_address text,
  launched_at timestamptz,
  metadata_synced_at timestamptz,
  usd_market_cap numeric(30,8),
  ath_usd_market_cap numeric(30,8),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(chain, mint_address)
);

CREATE TABLE IF NOT EXISTS x_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  x_user_id text,
  handle text NOT NULL,
  display_name text,
  profile_url text,
  avatar_url text,
  bio text,
  followers bigint NOT NULL DEFAULT 0,
  following bigint NOT NULL DEFAULT 0,
  posts_count bigint NOT NULL DEFAULT 0,
  verified boolean NOT NULL DEFAULT false,
  verified_type text,
  joined_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS x_accounts_handle_lower_uidx ON x_accounts(lower(handle));

CREATE TABLE IF NOT EXISTS x_posts (
  id text NOT NULL,
  created_at timestamptz NOT NULL,
  author_id uuid NOT NULL REFERENCES x_accounts(id) ON DELETE CASCADE,
  text text NOT NULL,
  url text,
  conversation_id text,
  reply_to_post_id text,
  quote_post_id text,
  language text,
  likes bigint NOT NULL DEFAULT 0,
  reposts bigint NOT NULL DEFAULT 0,
  replies bigint NOT NULL DEFAULT 0,
  quotes bigint NOT NULL DEFAULT 0,
  views bigint NOT NULL DEFAULT 0,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE IF NOT EXISTS x_posts_default PARTITION OF x_posts DEFAULT;
CREATE INDEX IF NOT EXISTS x_posts_created_brin ON x_posts USING brin(created_at);
CREATE INDEX IF NOT EXISTS x_posts_author_created_idx ON x_posts(author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS x_posts_text_fts_idx ON x_posts USING gin(to_tsvector('simple', text));

CREATE TABLE IF NOT EXISTS token_mentions (
  token_id uuid NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  post_id text NOT NULL,
  post_created_at timestamptz NOT NULL,
  match_type text NOT NULL CHECK (match_type IN ('contract','ticker','name','link','manual')),
  confidence real NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
  detected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(token_id, post_id, post_created_at, match_type),
  FOREIGN KEY(post_id, post_created_at) REFERENCES x_posts(id, created_at) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS token_mentions_token_time_idx ON token_mentions(token_id, post_created_at DESC);

CREATE TABLE IF NOT EXISTS account_edges (
  id bigserial PRIMARY KEY,
  source_account_id uuid NOT NULL REFERENCES x_accounts(id) ON DELETE CASCADE,
  target_account_id uuid NOT NULL REFERENCES x_accounts(id) ON DELETE CASCADE,
  token_id uuid REFERENCES tokens(id) ON DELETE CASCADE,
  edge_type text NOT NULL,
  weight real NOT NULL DEFAULT 0,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL,
  UNIQUE(source_account_id, target_account_id, token_id, edge_type, observed_at)
);
CREATE INDEX IF NOT EXISTS account_edges_token_idx ON account_edges(token_id, weight DESC);
CREATE INDEX IF NOT EXISTS account_edges_source_idx ON account_edges(source_account_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS account_edges_target_idx ON account_edges(target_account_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS analysis_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id uuid REFERENCES tokens(id) ON DELETE CASCADE,
  provider text NOT NULL,
  status text NOT NULL CHECK(status IN ('queued','running','completed','failed')),
  query jsonb NOT NULL,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS analysis_runs_token_created_idx ON analysis_runs(token_id, created_at DESC);

CREATE TABLE IF NOT EXISTS clusters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_run_id uuid NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  token_id uuid REFERENCES tokens(id) ON DELETE CASCADE,
  label text,
  coordination_score real NOT NULL,
  density real NOT NULL,
  originator_account_id uuid REFERENCES x_accounts(id) ON DELETE SET NULL,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cluster_members (
  cluster_id uuid NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES x_accounts(id) ON DELETE CASCADE,
  role text NOT NULL,
  influence_score real NOT NULL DEFAULT 0,
  risk_score real NOT NULL DEFAULT 0,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY(cluster_id, account_id)
);

CREATE TABLE IF NOT EXISTS token_snapshots (
  token_id uuid NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  captured_at timestamptz NOT NULL DEFAULT now(),
  mentions_count bigint NOT NULL DEFAULT 0,
  unique_accounts bigint NOT NULL DEFAULT 0,
  coordination_score real,
  organic_score real,
  influence_score real,
  market_cap_usd numeric(30,8),
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY(token_id, captured_at)
) PARTITION BY RANGE (captured_at);
CREATE TABLE IF NOT EXISTS token_snapshots_default PARTITION OF token_snapshots DEFAULT;
CREATE INDEX IF NOT EXISTS token_snapshots_time_brin ON token_snapshots USING brin(captured_at);

CREATE TABLE IF NOT EXISTS import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  filename text,
  checksum text,
  rows_received integer NOT NULL DEFAULT 0,
  rows_inserted integer NOT NULL DEFAULT 0,
  rows_rejected integer NOT NULL DEFAULT 0,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
