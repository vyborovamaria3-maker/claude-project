CREATE TABLE IF NOT EXISTS outbox (
  id BIGSERIAL PRIMARY KEY,
  topic TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  published_at BIGINT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  available_at BIGINT NOT NULL DEFAULT 0,
  claimed_at BIGINT,
  claimed_by TEXT,
  failed_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_outbox_unpublished ON outbox(available_at, created_at) WHERE published_at IS NULL AND failed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_outbox_topic ON outbox(topic, created_at DESC);

CREATE OR REPLACE FUNCTION emit_tweet_event() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO outbox (topic, payload, created_at)
  VALUES ('tweet.collected', jsonb_build_object('tweet_id', NEW.tweet_id,'handle', NEW.handle,'posted_at', NEW.posted_at),
    (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT);
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tweet_emit_event ON twitter_tweets;
CREATE TRIGGER trg_tweet_emit_event AFTER INSERT ON twitter_tweets FOR EACH ROW EXECUTE FUNCTION emit_tweet_event();

CREATE TABLE IF NOT EXISTS proxies (
  server TEXT PRIMARY KEY,
  region TEXT NOT NULL DEFAULT 'unknown',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cooldown','dead')),
  latency_ms INTEGER,
  success_count BIGINT NOT NULL DEFAULT 0,
  fail_count BIGINT NOT NULL DEFAULT 0,
  consecutive_fails INTEGER NOT NULL DEFAULT 0,
  cooldown_until BIGINT NOT NULL DEFAULT 0,
  last_check_at BIGINT,
  credentials JSONB,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proxies_pickable ON proxies(status, region, latency_ms) WHERE status = 'active';

ALTER TABLE x_accounts ADD COLUMN IF NOT EXISTS preferred_proxy TEXT REFERENCES proxies(server);

CREATE TABLE IF NOT EXISTS feature_flags (
  name TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  rollout_pct INTEGER NOT NULL DEFAULT 100 CHECK (rollout_pct BETWEEN 0 AND 100),
  payload JSONB,
  description TEXT,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_daily_stats (
  day DATE NOT NULL,
  account_name TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  rate_limits INTEGER NOT NULL DEFAULT 0,
  captchas INTEGER NOT NULL DEFAULT 0,
  bans INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  avg_task_ms NUMERIC(10,2),
  PRIMARY KEY (day, account_name)
);
CREATE INDEX IF NOT EXISTS idx_ads_account_day ON account_daily_stats(account_name, day DESC);

CREATE TABLE IF NOT EXISTS account_state_log (
  id BIGSERIAL PRIMARY KEY,
  account_name TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  changed_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_asl_account ON account_state_log(account_name, changed_at DESC);

CREATE TABLE IF NOT EXISTS session_rotations (
  id BIGSERIAL PRIMARY KEY,
  account_name TEXT NOT NULL,
  rotated_at BIGINT NOT NULL,
  reason TEXT NOT NULL,
  old_fingerprint TEXT,
  new_fingerprint TEXT
);
CREATE INDEX IF NOT EXISTS idx_rotations_account ON session_rotations(account_name, rotated_at DESC);

ALTER TABLE twitter_tweets ADD COLUMN IF NOT EXISTS text_fts tsvector GENERATED ALWAYS AS (to_tsvector('simple', COALESCE(text, ''))) STORED;
CREATE INDEX IF NOT EXISTS idx_tweets_fts ON twitter_tweets USING gin(text_fts);

DROP MATERIALIZED VIEW IF EXISTS mv_author_token_stats CASCADE;
CREATE MATERIALIZED VIEW mv_author_token_stats AS
SELECT t.handle,
  l.mint,
  COUNT(DISTINCT t.tweet_id)::INT AS tweets_count,
  COALESCE(SUM(t.views), 0)::BIGINT AS total_views,
  COALESCE(SUM(t.likes), 0)::BIGINT AS total_likes,
  COALESCE(SUM(t.retweets), 0)::BIGINT AS total_retweets,
  COALESCE(AVG(t.views), 0)::NUMERIC(14,2) AS avg_views,
  COALESCE(AVG(t.likes), 0)::NUMERIC(14,2) AS avg_likes,
  MIN(t.posted_at) AS first_tweeted_at,
  MAX(t.posted_at) AS last_tweeted_at,
  BOOL_OR(t.is_verified) AS is_verified,
  (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT AS updated_at
FROM twitter_tweets t
JOIN tweet_token_links l ON l.tweet_id = t.tweet_id
GROUP BY t.handle, l.mint;
CREATE UNIQUE INDEX IF NOT EXISTS mv_ats_pk ON mv_author_token_stats(handle, mint);
CREATE INDEX IF NOT EXISTS mv_ats_mint_views ON mv_author_token_stats(mint, total_views DESC);
CREATE INDEX IF NOT EXISTS mv_ats_handle ON mv_author_token_stats(handle);

DROP MATERIALIZED VIEW IF EXISTS mv_author_cooccurrence CASCADE;
CREATE MATERIALIZED VIEW mv_author_cooccurrence AS
WITH pairs AS (
  SELECT a.handle AS ha, b.handle AS hb, COUNT(DISTINCT a.mint) AS shared
  FROM tweet_token_links a
  JOIN tweet_token_links b ON a.mint = b.mint AND a.handle < b.handle
  GROUP BY a.handle, b.handle
)
SELECT ha AS handle_a, hb AS handle_b, shared AS shared_mints,
       (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT AS last_seen
FROM pairs WHERE shared >= 2 AND shared <= 1000;
CREATE UNIQUE INDEX IF NOT EXISTS mv_cooc_pk ON mv_author_cooccurrence(handle_a, handle_b);
CREATE INDEX IF NOT EXISTS mv_cooc_shared ON mv_author_cooccurrence(shared_mints DESC);

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_daily_mint_stats AS
SELECT to_char(to_timestamp(t.posted_at / 1000), 'YYYY-MM-DD') AS day,
  l.mint,
  COUNT(DISTINCT t.tweet_id)::INT AS tweets,
  COUNT(DISTINCT t.handle)::INT AS authors,
  COALESCE(SUM(t.views), 0)::BIGINT AS views,
  COALESCE(SUM(t.likes), 0)::BIGINT AS likes
FROM twitter_tweets t
JOIN tweet_token_links l ON l.tweet_id = t.tweet_id
WHERE t.posted_at IS NOT NULL
GROUP BY day, l.mint;
CREATE UNIQUE INDEX IF NOT EXISTS mv_dms_pk ON mv_daily_mint_stats(day, mint);
CREATE INDEX IF NOT EXISTS mv_dms_mint ON mv_daily_mint_stats(mint, day DESC);

CREATE TABLE IF NOT EXISTS retention_policies (
  table_name TEXT PRIMARY KEY,
  retention_days INTEGER NOT NULL,
  archive_to_s3 BOOLEAN NOT NULL DEFAULT FALSE,
  last_run_at BIGINT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE
);
INSERT INTO retention_policies (table_name, retention_days, archive_to_s3) VALUES
  ('twitter_tweets', 90, TRUE),
  ('tweet_token_links', 90, FALSE),
  ('x_tasks', 30, FALSE),
  ('x_tasks_dlq', 180, FALSE),
  ('outbox', 7, FALSE),
  ('account_daily_stats', 365, FALSE),
  ('account_state_log', 90, FALSE),
  ('session_rotations', 365, FALSE),
  ('scrape_runs', 30, FALSE),
  ('mint_attention_snapshots', 180, FALSE),
  ('signal_history', 90, FALSE),
  ('mint_metrics_1m', 14, FALSE),
  ('mint_metrics_1h', 180, FALSE),
  ('mint_metrics_1d', 1825, FALSE),
  ('mint_metrics_1w', 3650, FALSE),
  ('author_metrics_1d', 365, FALSE),
  ('ml_feature_snapshots', 365, FALSE)
ON CONFLICT (table_name) DO NOTHING;

CREATE TABLE IF NOT EXISTS table_size_snapshots (
  snapshot_at BIGINT NOT NULL,
  table_name TEXT NOT NULL,
  row_count BIGINT NOT NULL,
  size_bytes BIGINT NOT NULL,
  index_bytes BIGINT NOT NULL,
  PRIMARY KEY (snapshot_at, table_name)
);
CREATE INDEX IF NOT EXISTS idx_tss_table ON table_size_snapshots(table_name, snapshot_at DESC);

CREATE OR REPLACE FUNCTION log_account_change() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO account_state_log (account_name, from_status, to_status, reason, changed_at)
    VALUES (NEW.name, OLD.status, NEW.status, COALESCE(NEW.last_error_at::text, 'auto'),
            (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_account_state ON x_accounts;
CREATE TRIGGER trg_account_state AFTER UPDATE ON x_accounts FOR EACH ROW EXECUTE FUNCTION log_account_change();

CREATE INDEX IF NOT EXISTS idx_ttl_mint_handle_cover ON tweet_token_links(mint, handle) INCLUDE (linked_at);
CREATE INDEX IF NOT EXISTS idx_tweets_handle_posted_cover ON twitter_tweets(handle, posted_at DESC) INCLUDE (views, likes, retweets);
CREATE INDEX IF NOT EXISTS idx_dlq_kind_unreviewed ON x_tasks_dlq(kind, failed_at DESC) WHERE reviewed_at IS NULL;

DROP VIEW IF EXISTS v_active_tasks CASCADE;
CREATE VIEW v_active_tasks AS
SELECT t.id, t.kind, t.mint, t.handle, t.attempts, t.max_attempts,
       t.claimed_by, t.claimed_at, t.lease_expires_at,
       (t.lease_expires_at - (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT) AS lease_remaining_ms
FROM x_tasks t WHERE t.status = 'claimed';

CREATE OR REPLACE FUNCTION refresh_all_mvs() RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_author_token_stats;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_author_cooccurrence;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_mint_stats;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION snapshot_table_sizes() RETURNS void AS $$
DECLARE snap BIGINT := (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT;
BEGIN
  INSERT INTO table_size_snapshots (snapshot_at, table_name, row_count, size_bytes, index_bytes)
  SELECT snap, c.relname, COALESCE(s.n_live_tup, 0),
         pg_total_relation_size(c.oid) - pg_indexes_size(c.oid),
         pg_indexes_size(c.oid)
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname NOT LIKE 'pg_%';
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION apply_retention(dry_run BOOLEAN DEFAULT FALSE)
RETURNS TABLE(table_name TEXT, deleted BIGINT) AS $$
DECLARE
  pol RECORD;
  cnt BIGINT;
  cutoff_ms BIGINT;
  cutoff_day DATE;
  predicate TEXT;
  time_column TEXT;
  sql_text TEXT;
BEGIN
  FOR pol IN
    SELECT * FROM retention_policies WHERE enabled = TRUE ORDER BY table_name
  LOOP
    IF pol.retention_days < 1 OR pol.retention_days > 36500 THEN
      RAISE NOTICE 'Skipping invalid retention_days=% for table %', pol.retention_days, pol.table_name;
      CONTINUE;
    END IF;
    IF pol.archive_to_s3 AND NOT dry_run THEN
      RAISE NOTICE 'Skipping destructive retention for % because S3 archival is not implemented', pol.table_name;
      CONTINUE;
    END IF;
    cutoff_ms := (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
                 - (pol.retention_days::BIGINT * 86400000);
    cutoff_day := CURRENT_DATE - pol.retention_days;

    -- Explicit allow-list: never execute a table name supplied only by a policy row.
    time_column := CASE pol.table_name
      WHEN 'twitter_tweets' THEN 'first_seen_at'
      WHEN 'tweet_token_links' THEN 'linked_at'
      WHEN 'x_tasks' THEN 'created_at'
      WHEN 'x_tasks_dlq' THEN 'failed_at'
      WHEN 'outbox' THEN 'created_at'
      WHEN 'account_daily_stats' THEN 'day'
      WHEN 'account_state_log' THEN 'changed_at'
      WHEN 'session_rotations' THEN 'rotated_at'
      WHEN 'scrape_runs' THEN 'started_at'
      WHEN 'mint_attention_snapshots' THEN 'observed_at'
      WHEN 'signal_history' THEN 'signal_at'
      WHEN 'mint_metrics_1m' THEN 'bucket'
      WHEN 'mint_metrics_1h' THEN 'bucket'
      WHEN 'mint_metrics_1d' THEN 'bucket'
      WHEN 'mint_metrics_1w' THEN 'bucket'
      WHEN 'author_metrics_1d' THEN 'bucket'
      WHEN 'ml_feature_snapshots' THEN 'snapshot_at'
      ELSE NULL
    END;
    IF time_column IS NULL THEN
      RAISE NOTICE 'Skipping unsupported retention table: %', pol.table_name;
      CONTINUE;
    END IF;

    predicate := format('%I < $1', time_column);
    IF pol.table_name = 'x_tasks' THEN
      predicate := predicate || ' AND status IN (''done'', ''failed'')';
    ELSIF pol.table_name = 'outbox' THEN
      predicate := predicate || ' AND (published_at IS NOT NULL OR failed_at IS NOT NULL)';
    ELSIF pol.table_name = 'scrape_runs' THEN
      predicate := predicate || ' AND status IN (''done'', ''failed'', ''aborted'')';
    END IF;

    IF pol.table_name = 'account_daily_stats' THEN
      IF dry_run THEN
        sql_text := format('SELECT COUNT(*) FROM %I WHERE %s', pol.table_name, predicate);
        EXECUTE sql_text INTO cnt USING cutoff_day;
      ELSE
        sql_text := format(
          'WITH doomed AS (SELECT ctid FROM %I WHERE %s ORDER BY %I LIMIT 100000) DELETE FROM %I t USING doomed d WHERE t.ctid = d.ctid',
          pol.table_name, predicate, time_column, pol.table_name
        );
        EXECUTE sql_text USING cutoff_day;
        GET DIAGNOSTICS cnt = ROW_COUNT;
      END IF;
    ELSE
      IF dry_run THEN
        sql_text := format('SELECT COUNT(*) FROM %I WHERE %s', pol.table_name, predicate);
        EXECUTE sql_text INTO cnt USING cutoff_ms;
      ELSE
        sql_text := format(
          'WITH doomed AS (SELECT ctid FROM %I WHERE %s ORDER BY %I LIMIT 100000) DELETE FROM %I t USING doomed d WHERE t.ctid = d.ctid',
          pol.table_name, predicate, time_column, pol.table_name
        );
        EXECUTE sql_text USING cutoff_ms;
        GET DIAGNOSTICS cnt = ROW_COUNT;
        UPDATE retention_policies
        SET last_run_at = (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
        WHERE retention_policies.table_name = pol.table_name;
      END IF;
    END IF;

    IF pol.table_name = 'account_daily_stats' AND NOT dry_run THEN
      UPDATE retention_policies
      SET last_run_at = (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
      WHERE retention_policies.table_name = pol.table_name;
    END IF;

    table_name := pol.table_name;
    deleted := cnt;
    RETURN NEXT;
  END LOOP;
END $$ LANGUAGE plpgsql;
