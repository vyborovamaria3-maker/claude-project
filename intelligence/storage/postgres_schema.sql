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

CREATE INDEX IF NOT EXISTS idx_intelligence_documents_recent
    ON intelligence_documents(collected_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_intelligence_documents_source_collected
    ON intelligence_documents(source, collected_at DESC);

CREATE INDEX IF NOT EXISTS idx_intelligence_documents_provider
    ON intelligence_documents(provider)
    WHERE provider IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_intelligence_documents_published_at
    ON intelligence_documents(published_at DESC)
    WHERE published_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS intelligence_jobs (
    id TEXT PRIMARY KEY,
    payload_json JSONB NOT NULL,
    status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    result_document_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    error TEXT,
    CONSTRAINT intelligence_jobs_payload_object
        CHECK (jsonb_typeof(payload_json) = 'object'),
    CONSTRAINT intelligence_jobs_result_ids_array
        CHECK (jsonb_typeof(result_document_ids_json) = 'array'),
    CONSTRAINT intelligence_jobs_status_allowed
        CHECK (status IN ('created', 'queued', 'running', 'completed', 'failed', 'retry'))
);

CREATE INDEX IF NOT EXISTS idx_intelligence_jobs_status_created
    ON intelligence_jobs(status, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_intelligence_jobs_recent
    ON intelligence_jobs(created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_intelligence_jobs_status_recent
    ON intelligence_jobs(status, created_at DESC);

COMMIT;
