-- AI Reply Guy - Расширенная миграция БД
DO $$ BEGIN CREATE EXTENSION IF NOT EXISTS pg_trgm; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pg_trgm skip'; END $$;

-- Таблица пользователей и доступов
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id BIGINT UNIQUE NOT NULL,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000,
  updated_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000,
  subscription_status TEXT NOT NULL DEFAULT 'free',
  subscription_expires_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);

-- Аккаунты X
CREATE TABLE IF NOT EXISTS x_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  x_username TEXT NOT NULL,
  x_handle TEXT NOT NULL,
  cookies_encrypted BYTEA NOT NULL,
  auth_token_encrypted BYTEA NOT NULL,
  ct0_encrypted BYTEA NOT NULL,
  proxy_encrypted BYTEA,
  browser_profile TEXT NOT NULL DEFAULT 'chrome_windows',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','banned','deleted')),
  tier TEXT NOT NULL DEFAULT 'new' CHECK (tier IN ('new','warm','hot','retired')),
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000,
  updated_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000,
  last_activity_at BIGINT,
  total_tweets_replied BIGINT NOT NULL DEFAULT 0,
  total_hours_active BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_x_accounts_user_id ON x_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_x_accounts_status ON x_accounts(status);

-- Прокси
CREATE TABLE IF NOT EXISTS proxies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES x_accounts(id) ON DELETE CASCADE,
  proxy_encrypted BYTEA NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('http','https','socks4','socks5')),
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  login TEXT,
  password TEXT,
  geo_location TEXT NOT NULL DEFAULT 'us',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','dead','testing')),
  last_check_at BIGINT,
  latency_ms INTEGER,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000,
  updated_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
);
CREATE INDEX IF NOT EXISTS idx_proxies_account_id ON proxies(account_id);
CREATE INDEX IF NOT EXISTS idx_proxies_status ON proxies(status);

-- Персонаж (Lore)
CREATE TABLE IF NOT EXISTS loras (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  style TEXT NOT NULL,
  bio TEXT NOT NULL,
  system_prompt TEXT,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000,
  updated_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
);
CREATE INDEX IF NOT EXISTS idx_loras_user_id ON loras(user_id);

-- Примеры RAG
CREATE TABLE IF NOT EXISTS lore_examples (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lore_id UUID NOT NULL REFERENCES loras(id) ON DELETE CASCADE,
  tweet_text TEXT NOT NULL,
  reply_text TEXT NOT NULL,
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
);
CREATE INDEX IF NOT EXISTS idx_lore_examples_lore_id ON lore_examples(lore_id);

-- Браузерные профили
CREATE TABLE IF NOT EXISTS browser_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  user_agent TEXT NOT NULL,
  timezone TEXT NOT NULL,
  os TEXT NOT NULL,
  version TEXT NOT NULL,
  challenges TEXT[], -- Кастомные JavaScript-всылки
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000,
  updated_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
);
INSERT INTO browser_profiles (name, user_agent, timezone, os, version) VALUES
  ('chrome_windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'America/New_York', 'Windows', '120.0.0.0'),
  ('chrome_macos', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'America/Los_Angeles', 'macOS', '120.0.0.0'),
  ('firefox_windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0', 'Europe/London', 'Windows', '121.0'),
  ('safari_macos', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15', 'America/New_York', 'macOS', '17.2');

-- Кампании
CREATE TABLE IF NOT EXISTS campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES x_accounts(id) ON DELETE CASCADE,
  lore_id UUID NOT NULL REFERENCES loras(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'inactive' CHECK (status IN ('active','inactive','paused','stopped')),
  settings_json JSONB NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000,
  updated_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
);
CREATE INDEX IF NOT EXISTS idx_campaigns_account_id ON campaigns(account_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);

-- Источники твитов
CREATE TABLE IF NOT EXISTS campaigns_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('list','search')),
  value TEXT NOT NULL, -- ID списка или фраза поиска
  priority INTEGER NOT NULL DEFAULT 5 CHECK (priority >= 1 AND priority <= 10),
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
);
CREATE INDEX IF NOT EXISTS idx_campaigns_sources_campaign_id ON campaigns_sources(campaign_id);

-- Фильтры твитов
CREATE TABLE IF NOT EXISTS campaign_filters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  min_age_minutes INTEGER NOT NULL DEFAULT 1,
  max_age_minutes INTEGER NOT NULL DEFAULT 10,
  skip_replies BOOLEAN NOT NULL DEFAULT FALSE,
  skip_retweets BOOLEAN NOT NULL DEFAULT FALSE,
  skip_quotes BOOLEAN NOT NULL DEFAULT FALSE,
  min_likes INTEGER NOT NULL DEFAULT 0,
  min_retweets INTEGER NOT NULL DEFAULT 0,
  min_followers INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000,
  updated_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_filters_campaign_id ON campaign_filters(campaign_id);

-- Чёрные списки
CREATE TABLE IF NOT EXISTS campaign_blacklists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('word','user')),
  value TEXT NOT NULL,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
);
CREATE INDEX IF NOT EXISTS idx_campaign_blacklists_campaign_id ON campaign_blacklists(campaign_id);

-- Rate limiting
CREATE TABLE IF NOT EXISTS rate_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  hour_epoch BIGINT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000,
  updated_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000,
  UNIQUE(campaign_id, hour_epoch)
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_campaign_id ON rate_limits(campaign_id);

-- Севые ответов
CREATE TABLE IF NOT EXISTS replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  tweet_id TEXT NOT NULL,
  tweet_author TEXT NOT NULL,
  tweet_text TEXT NOT NULL,
  reply_text TEXT NOT NULL,
  published_at BIGINT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published','failed','draft')),
  error_message TEXT,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000,
  updated_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
);
CREATE INDEX IF NOT EXISTS idx_replies_campaign_id ON replies(campaign_id);
CREATE INDEX IF NOT EXISTS idx_replies_status ON replies(status);

-- Alertы
CREATE TABLE IF NOT EXISTS alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID,
  type TEXT NOT NULL CHECK (type IN ('warning','error','success','info')),
  message TEXT NOT NULL,
  read_at BIGINT,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
);
CREATE INDEX IF NOT EXISTS idx_alerts_user_id ON alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_alerts_type ON alerts(type);

-- ВАЖНО: Добавить индекс для RAG поиска
CREATE EXTENSION IF NOT EXISTS pgvector;
CREATE INDEX IF NOT EXISTS idx_lore_examples_embedding ON lore_examples USING hnsw (embedding vector_cosine_ops);

COMMENT ON TABLE users IS 'Пользователи системы';
COMMENT ON TABLE x_accounts IS 'Аккаунты X (Twitter)';
COMMENT ON TABLE loras IS 'Персонажи (lore)';
COMMENT ON TABLE campaigns IS 'Кампании автоматических ответов';
