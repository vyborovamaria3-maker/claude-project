BEGIN;

CREATE TABLE IF NOT EXISTS intelligence_documents (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    content TEXT NOT NULL,
    collected_at TIMESTAMPTZ NOT NULL,
    url TEXT,
    author TEXT,
    provider TEXT,
    published_at TIMESTAMPTZ,
    entities_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    metrics_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    raw_hash TEXT UNIQUE,
    CONSTRAINT intelligence_documents_entities_array
        CHECK (jsonb_typeof(entities_json) = 'array'),
    CONSTRAINT intelligence_documents_metrics_object
        CHECK (jsonb_typeof(metrics_json) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_intelligence_documents_source
    ON intelligence_documents(source);

CREATE INDEX IF NOT EXISTS idx_intelligence_documents_collected_at
    ON intelligence_documents(collected_at DESC);

CREATE INDEX IF NOT EXISTS idx_intelligence_documents_provider
    ON intelligence_documents(provider)
    WHERE provider IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_intelligence_documents_published_at
    ON intelligence_documents(published_at DESC)
    WHERE published_at IS NOT NULL;

COMMIT;
