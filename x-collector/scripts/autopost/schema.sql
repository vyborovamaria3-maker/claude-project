CREATE TABLE IF NOT EXISTS xc_ai_providers (
 id text PRIMARY KEY, label text NOT NULL, protocol text NOT NULL CHECK(protocol IN ('openai','anthropic','gemini','ollama','custom')),
 endpoint text NOT NULL, model text NOT NULL, secret bytea, adapter text, created_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS xc_auto_config (
 account_name text PRIMARY KEY REFERENCES x_accounts(name) ON DELETE CASCADE, enabled boolean NOT NULL DEFAULT false,
 expected_handle text NOT NULL, provider_id text REFERENCES xc_ai_providers(id), language text NOT NULL DEFAULT 'ru',
 style text NOT NULL DEFAULT 'Короткие наблюдения о мемкоинах Solana с указанием источника.',
 kinds jsonb NOT NULL DEFAULT '["post"]', interval_minutes int NOT NULL DEFAULT 120 CHECK(interval_minutes BETWEEN 5 AND 10080),
 daily_limit int NOT NULL DEFAULT 4 CHECK(daily_limit BETWEEN 1 AND 100), start_hour int NOT NULL DEFAULT 9 CHECK(start_hour BETWEEN 0 AND 23),
 end_hour int NOT NULL DEFAULT 23 CHECK(end_hour BETWEEN 0 AND 23), next_run bigint NOT NULL DEFAULT 0, last_message text,
 updated_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS xc_auto_control (id int PRIMARY KEY CHECK(id=1),paused boolean NOT NULL DEFAULT true,heartbeat bigint);
INSERT INTO xc_auto_control(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS xc_auto_jobs (
 id text PRIMARY KEY,account_name text NOT NULL,expected_handle text NOT NULL,kind text NOT NULL CHECK(kind IN ('post','reply','like','repost','follow')),
 content text, target_id text,target_handle text,evidence jsonb NOT NULL DEFAULT '[]',reason text NOT NULL DEFAULT '',provider_id text,
 dedup text NOT NULL UNIQUE,status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','published','failed','uncertain','cancelled')),
 attempted boolean NOT NULL DEFAULT false,scheduled_at bigint NOT NULL,created_at bigint NOT NULL,started_at bigint,finished_at bigint,
 lease_until bigint,result_id text,result_url text,message text,origin text NOT NULL DEFAULT 'manual'
);
CREATE INDEX IF NOT EXISTS xc_auto_jobs_due ON xc_auto_jobs(status,scheduled_at);
CREATE INDEX IF NOT EXISTS xc_auto_jobs_account ON xc_auto_jobs(account_name,created_at DESC);
CREATE TABLE IF NOT EXISTS xc_auto_posts (
 tweet_id text PRIMARY KEY,account_name text NOT NULL,handle text NOT NULL,text text NOT NULL,url text NOT NULL,
 posted_at bigint NOT NULL,views bigint,likes bigint,replies bigint,retweets bigint,updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS xc_auto_posts_account ON xc_auto_posts(account_name,posted_at DESC);
CREATE TABLE IF NOT EXISTS xc_auto_metrics (
 tweet_id text NOT NULL REFERENCES xc_auto_posts(tweet_id) ON DELETE CASCADE,measured_at bigint NOT NULL,
 views bigint,likes bigint,replies bigint,retweets bigint,PRIMARY KEY(tweet_id,measured_at)
);
CREATE TABLE IF NOT EXISTS xc_auto_sync (
 id text PRIMARY KEY,account_name text NOT NULL,expected_handle text NOT NULL,tweet_id text NOT NULL,
 status text NOT NULL DEFAULT 'queued',message text,created_at bigint NOT NULL,finished_at bigint
);

ALTER TABLE xc_auto_jobs ADD COLUMN IF NOT EXISTS attempted_at bigint;
