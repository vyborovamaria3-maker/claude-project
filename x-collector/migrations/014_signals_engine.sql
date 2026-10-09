-- Depend on: 011_runtime_hardening.sql (signal_history), 013_intelligence.sql
-- SIGNALS ENGINE v1: собственные математические сигналы по сущностям X
-- (twitter_tweets + tweet_entities). Таблица signal_history переиспользуется:
-- 1) расширен CHECK источников — добавлен 'entity' (сигналы по сущностям);
-- 2) level вынесен в отдельную колонку, details остаётся под metadata JSON.

ALTER TABLE signal_history DROP CONSTRAINT IF EXISTS signal_history_source_check;
ALTER TABLE signal_history ADD CONSTRAINT signal_history_source_check
  CHECK (source IN ('hype', 'ultra', 'early_signal', 'entity'));

ALTER TABLE signal_history ADD COLUMN IF NOT EXISTS level TEXT
  CHECK (level IS NULL OR level IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL'));
