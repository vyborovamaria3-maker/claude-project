-- Intelligence AI enrichment pipeline jobs
-- Migration 030

CREATE TABLE IF NOT EXISTS ip_intelligence_jobs (
    id BIGSERIAL PRIMARY KEY,
    entity_id BIGINT REFERENCES ip_entities(id) ON DELETE CASCADE,
    job_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    priority INTEGER NOT NULL DEFAULT 0,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    result JSONB,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    scheduled_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ip_intelligence_jobs_status
    ON ip_intelligence_jobs(status, priority DESC);

CREATE INDEX IF NOT EXISTS idx_ip_intelligence_jobs_entity
    ON ip_intelligence_jobs(entity_id);

CREATE INDEX IF NOT EXISTS idx_ip_intelligence_jobs_type
    ON ip_intelligence_jobs(job_type);
