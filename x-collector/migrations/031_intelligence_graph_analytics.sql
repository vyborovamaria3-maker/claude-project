-- Intelligence Graph Analytics v1

CREATE TABLE IF NOT EXISTS ip_graph_metrics (
    id BIGSERIAL PRIMARY KEY,
    entity_id BIGINT NOT NULL REFERENCES ip_entities(id) ON DELETE CASCADE,
    metric_type TEXT NOT NULL,
    metric_value NUMERIC NOT NULL DEFAULT 0,
    metadata JSONB DEFAULT '{}'::jsonb,
    calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ip_graph_metrics_entity
ON ip_graph_metrics(entity_id);

CREATE INDEX IF NOT EXISTS idx_ip_graph_metrics_type
ON ip_graph_metrics(metric_type);

CREATE TABLE IF NOT EXISTS ip_graph_anomalies (
    id BIGSERIAL PRIMARY KEY,
    entity_id BIGINT REFERENCES ip_entities(id) ON DELETE CASCADE,
    anomaly_type TEXT NOT NULL,
    score NUMERIC NOT NULL DEFAULT 0,
    evidence JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ip_graph_anomalies_entity
ON ip_graph_anomalies(entity_id);
