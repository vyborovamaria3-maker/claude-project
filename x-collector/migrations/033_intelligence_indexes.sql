-- Intelligence storage optimization
-- Adds indexes for high-volume entity, relation and analytics queries

CREATE INDEX IF NOT EXISTS idx_ip_entities_external_id
ON ip_entities(external_id);

CREATE INDEX IF NOT EXISTS idx_ip_entity_relations_source_target
ON ip_entity_relations(source_entity_id, target_entity_id);

CREATE INDEX IF NOT EXISTS idx_ip_entity_tags_entity
ON ip_entity_tags(entity_id);

CREATE INDEX IF NOT EXISTS idx_ip_raw_events_entity_created
ON ip_raw_events(entity_id, created_at DESC);
