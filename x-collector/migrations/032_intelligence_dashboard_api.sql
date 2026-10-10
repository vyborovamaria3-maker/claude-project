-- Intelligence API support views
-- Adds lightweight aggregation layer over existing intelligence tables.

CREATE INDEX IF NOT EXISTS idx_ip_entity_scores_entity
ON ip_entity_scores(entity_id);

CREATE INDEX IF NOT EXISTS idx_ip_graph_metrics_entity
ON ip_graph_metrics(entity_id);

CREATE INDEX IF NOT EXISTS idx_ip_graph_anomalies_entity
ON ip_graph_anomalies(entity_id);
