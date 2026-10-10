-- Intelligence API support indexes
-- Adds the aggregation-layer indexes the dashboard API reads. Only references
-- tables that exist in 023_intelligence_platform.sql.

CREATE INDEX IF NOT EXISTS idx_ip_entity_profiles_risk
ON ip_entity_profiles(risk_score);

CREATE INDEX IF NOT EXISTS idx_ip_graph_clusters_computed
ON ip_graph_clusters(computed_at DESC);

CREATE INDEX IF NOT EXISTS idx_ip_raw_events_source_collected
ON ip_raw_events(source, collected_at DESC);
