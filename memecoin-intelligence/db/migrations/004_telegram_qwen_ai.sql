-- v3.3.0 Telegram-only AI foundation for Qwen2.5-7B-Instruct.
-- Additive schema: safe to migrate into another PostgreSQL project.
CREATE TABLE IF NOT EXISTS telegram_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id text NOT NULL,
  username text,
  title text,
  description text,
  members_count bigint,
  is_verified boolean NOT NULL DEFAULT false,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(telegram_id)
);
CREATE INDEX IF NOT EXISTS telegram_channels_username_lower_idx
  ON telegram_channels(lower(username)) WHERE username IS NOT NULL;

CREATE TABLE IF NOT EXISTS telegram_messages (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  sent_at timestamptz NOT NULL,
  channel_id uuid NOT NULL REFERENCES telegram_channels(id) ON DELETE CASCADE,
  message_id text NOT NULL,
  sender_id text,
  text text NOT NULL DEFAULT '',
  edited_at timestamptz,
  reply_to_message_id text,
  views bigint NOT NULL DEFAULT 0,
  forwards bigint NOT NULL DEFAULT 0,
  reactions bigint NOT NULL DEFAULT 0,
  links text[] NOT NULL DEFAULT '{}',
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(id, sent_at),
  UNIQUE(channel_id, message_id, sent_at)
) PARTITION BY RANGE(sent_at);
CREATE TABLE IF NOT EXISTS telegram_messages_default PARTITION OF telegram_messages DEFAULT;
CREATE INDEX IF NOT EXISTS telegram_messages_channel_time_idx ON telegram_messages(channel_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS telegram_messages_sent_brin ON telegram_messages USING brin(sent_at);
CREATE INDEX IF NOT EXISTS telegram_messages_text_fts_idx ON telegram_messages USING gin(to_tsvector('simple', text));
CREATE INDEX IF NOT EXISTS telegram_messages_links_gin ON telegram_messages USING gin(links);

CREATE TABLE IF NOT EXISTS telegram_message_features (
  message_id uuid NOT NULL,
  message_sent_at timestamptz NOT NULL,
  contracts text[] NOT NULL DEFAULT '{}',
  tickers text[] NOT NULL DEFAULT '{}',
  accounts text[] NOT NULL DEFAULT '{}',
  links text[] NOT NULL DEFAULT '{}',
  normalized_text text NOT NULL DEFAULT '',
  text_fingerprint text NOT NULL,
  language text,
  sentiment real,
  embedding real[],
  feature_version smallint NOT NULL DEFAULT 1,
  extracted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(message_id, message_sent_at),
  FOREIGN KEY(message_id, message_sent_at) REFERENCES telegram_messages(id, sent_at) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS telegram_features_contracts_gin ON telegram_message_features USING gin(contracts);
CREATE INDEX IF NOT EXISTS telegram_features_tickers_gin ON telegram_message_features USING gin(tickers);
CREATE INDEX IF NOT EXISTS telegram_features_accounts_gin ON telegram_message_features USING gin(accounts);
CREATE INDEX IF NOT EXISTS telegram_features_links_gin ON telegram_message_features USING gin(links);
CREATE INDEX IF NOT EXISTS telegram_features_fingerprint_idx ON telegram_message_features(text_fingerprint, message_sent_at DESC);

CREATE TABLE IF NOT EXISTS telegram_ai_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL CHECK(status IN ('queued','running','completed','failed')),
  mode text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  input_hash text NOT NULL,
  input_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  message_count integer NOT NULL CHECK(message_count > 0),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS telegram_ai_runs_status_created_idx ON telegram_ai_runs(status, created_at);
CREATE INDEX IF NOT EXISTS telegram_ai_runs_hash_idx ON telegram_ai_runs(input_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS telegram_ai_run_messages (
  run_id uuid NOT NULL REFERENCES telegram_ai_runs(id) ON DELETE CASCADE,
  message_id uuid NOT NULL,
  message_sent_at timestamptz NOT NULL,
  ordinal integer NOT NULL,
  PRIMARY KEY(run_id, message_id, message_sent_at),
  UNIQUE(run_id, ordinal),
  FOREIGN KEY(message_id, message_sent_at) REFERENCES telegram_messages(id, sent_at) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS telegram_ai_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL UNIQUE REFERENCES telegram_ai_runs(id) ON DELETE CASCADE,
  provider text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  schema_version smallint NOT NULL DEFAULT 1,
  result jsonb NOT NULL,
  latency_ms double precision NOT NULL,
  input_tokens integer,
  output_tokens integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS telegram_ai_results_created_idx ON telegram_ai_results(created_at DESC);
CREATE INDEX IF NOT EXISTS telegram_ai_results_json_gin ON telegram_ai_results USING gin(result jsonb_path_ops);

CREATE TABLE IF NOT EXISTS telegram_ai_cache (
  input_hash text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  result jsonb NOT NULL,
  latency_ms double precision NOT NULL,
  input_tokens integer,
  output_tokens integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(input_hash, model, prompt_version)
);
CREATE INDEX IF NOT EXISTS telegram_ai_cache_expiry_idx ON telegram_ai_cache(expires_at);

DO $$
DECLARE
  month_start date := date_trunc('month', now())::date - interval '1 month';
  i integer;
  from_date date;
  to_date date;
BEGIN
  FOR i IN 0..13 LOOP
    from_date := (month_start + (i || ' month')::interval)::date;
    to_date := (month_start + ((i + 1) || ' month')::interval)::date;
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS telegram_messages_%s PARTITION OF telegram_messages FOR VALUES FROM (%L) TO (%L)',
      to_char(from_date, 'YYYY_MM'), from_date, to_date
    );
  END LOOP;
END $$;
