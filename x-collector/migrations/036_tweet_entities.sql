CREATE TABLE IF NOT EXISTS tweet_entities (
    id BIGSERIAL PRIMARY KEY,
    tweet_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    value TEXT NOT NULL,
    normalized_value TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE(tweet_id, entity_type, normalized_value)
);

CREATE INDEX IF NOT EXISTS idx_tweet_entities_tweet_id
ON tweet_entities(tweet_id);

CREATE INDEX IF NOT EXISTS idx_tweet_entities_type_value
ON tweet_entities(entity_type, normalized_value);