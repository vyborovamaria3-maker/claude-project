CREATE TABLE tg_pump_history_cache (
 query_key text PRIMARY KEY,
 result jsonb NOT NULL,
 expires_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
