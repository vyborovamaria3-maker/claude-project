-- Additive, isolated from collector accounts/tasks. No production data rewrite.
CREATE TABLE IF NOT EXISTS reply_users (
 id BIGSERIAL PRIMARY KEY, telegram_id TEXT UNIQUE NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reply_tokens (
 jti TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES reply_users ON DELETE CASCADE,
 expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS reply_lore (
 id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES reply_users ON DELETE CASCADE,
 name TEXT NOT NULL, style TEXT NOT NULL, country TEXT NOT NULL DEFAULT '', bio TEXT NOT NULL DEFAULT '', system_prompt TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS reply_examples (
 id BIGSERIAL PRIMARY KEY, lore_id BIGINT NOT NULL REFERENCES reply_lore ON DELETE CASCADE,
 tweet_text TEXT NOT NULL, reply_text TEXT NOT NULL, embedding JSONB NOT NULL,
 embedding_model TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reply_accounts (
 id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES reply_users ON DELETE CASCADE,
 x_user_id TEXT, x_username TEXT, credentials_encrypted TEXT NOT NULL,
 proxy_encrypted TEXT, proxy_fingerprint TEXT UNIQUE, proxy_status TEXT NOT NULL DEFAULT 'none'
 CHECK(proxy_status IN ('none','ready','dead')), proxy_latency_ms INTEGER,
 proxy_country TEXT, timezone TEXT NOT NULL DEFAULT 'Europe/Moscow', browser_profile TEXT NOT NULL DEFAULT 'official-api',
 status TEXT NOT NULL DEFAULT 'needs_auth' CHECK(status IN ('ready','paused','needs_auth','blocked')),
 last_health_at TIMESTAMPTZ, cooldown_until TIMESTAMPTZ, next_reply_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(x_user_id), UNIQUE(id,user_id)
);
CREATE TABLE IF NOT EXISTS reply_campaigns (
 id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES reply_users ON DELETE CASCADE,
 account_id BIGINT UNIQUE NOT NULL, lore_id BIGINT NOT NULL REFERENCES reply_lore,
 status TEXT NOT NULL DEFAULT 'stopped' CHECK(status IN ('running','stopped')),
 settings_json JSONB NOT NULL, filters_json JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(account_id,user_id) REFERENCES reply_accounts(id,user_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS reply_sources (
 id BIGSERIAL PRIMARY KEY, campaign_id BIGINT NOT NULL REFERENCES reply_campaigns ON DELETE CASCADE,
 type TEXT NOT NULL CHECK(type IN ('search','list')), value TEXT NOT NULL,
 priority INTEGER NOT NULL CHECK(priority BETWEEN 1 AND 10), since_id TEXT, next_token TEXT, page_newest_id TEXT,
 UNIQUE(campaign_id,type,value)
);
CREATE TABLE IF NOT EXISTS reply_blacklists (
 id BIGSERIAL PRIMARY KEY, campaign_id BIGINT NOT NULL REFERENCES reply_campaigns ON DELETE CASCADE,
 type TEXT NOT NULL CHECK(type IN ('word','account')), value TEXT NOT NULL,
 UNIQUE(campaign_id,type,value)
);
CREATE TABLE IF NOT EXISTS reply_consents (
 id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES reply_users ON DELETE CASCADE,
 author_id TEXT NOT NULL, evidence TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
 UNIQUE(user_id,author_id)
);
CREATE TABLE IF NOT EXISTS reply_drafts (
 id BIGSERIAL PRIMARY KEY, campaign_id BIGINT NOT NULL REFERENCES reply_campaigns ON DELETE CASCADE,
 account_id BIGINT NOT NULL REFERENCES reply_accounts ON DELETE CASCADE,
 tweet_id TEXT NOT NULL, author_id TEXT NOT NULL, tweet_json JSONB NOT NULL,
 reply_text TEXT, status TEXT NOT NULL DEFAULT 'pending'
 CHECK(status IN ('pending','review','approved','publishing','published','rejected','failed','uncertain')),
 approved_at TIMESTAMPTZ, publish_started_at TIMESTAMPTZ, published_at TIMESTAMPTZ, x_reply_id TEXT, last_error TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(account_id,tweet_id)
);
CREATE INDEX IF NOT EXISTS reply_drafts_queue ON reply_drafts(account_id,status,created_at);
CREATE TABLE IF NOT EXISTS reply_rate_limits (
 account_id BIGINT NOT NULL REFERENCES reply_accounts ON DELETE CASCADE,
 hour_epoch BIGINT NOT NULL, count INTEGER NOT NULL DEFAULT 0 CHECK(count>=0),
 PRIMARY KEY(account_id,hour_epoch)
);
CREATE TABLE IF NOT EXISTS reply_alerts (
 id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES reply_users ON DELETE CASCADE,
 account_id BIGINT REFERENCES reply_accounts ON DELETE CASCADE,
 type TEXT NOT NULL, message TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 delivered_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS reply_alerts_pending ON reply_alerts(created_at) WHERE delivered_at IS NULL;
CREATE TABLE IF NOT EXISTS reply_service_state (service TEXT PRIMARY KEY,value_json JSONB NOT NULL);
