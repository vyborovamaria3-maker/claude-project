-- ЗАВИСИТ ОТ: 001 (twitter_tweets)
-- Intelligence layer v1: маркер «твит разобран экстрактором сущностей».
-- Существующие таблицы не создаются: сущности пишутся в tweet_entities (005_nlp.sql).
ALTER TABLE twitter_tweets ADD COLUMN IF NOT EXISTS entities_processed_at BIGINT;

-- Частичный индекс под выборку необработанных (worker ходит LIMIT 100).
-- Обычный idx_tweets_first_seen покрывает ORDER BY, но не фильтр IS NULL.
CREATE INDEX IF NOT EXISTS idx_tweets_entities_pending
  ON twitter_tweets (first_seen_at)
  WHERE entities_processed_at IS NULL;
