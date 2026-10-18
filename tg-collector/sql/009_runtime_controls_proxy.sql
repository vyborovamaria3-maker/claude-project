-- Runtime controls are persisted in PostgreSQL so the UI can safely pause/resume
-- collection without killing the worker process.
ALTER TABLE tg_runtime ADD COLUMN IF NOT EXISTS collection_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- One Telegram transport proxy configuration. Secrets are encrypted by the worker
-- with TG_PROXY_ENCRYPTION_KEY (or the existing TG_API_HASH as a local fallback).
CREATE TABLE IF NOT EXISTS tg_proxy_config (
  id INTEGER PRIMARY KEY CHECK (id=1),
  proxy_type TEXT NOT NULL CHECK (proxy_type IN ('socks5','socks4','mtproxy')),
  host TEXT NOT NULL,
  port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  username_enc TEXT,
  password_enc TEXT,
  secret_enc TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
