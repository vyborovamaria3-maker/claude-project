-- Repeated A -> B -> A observations must retain all three capture times.
ALTER TABLE ip_raw_events DROP CONSTRAINT ip_raw_events_source_event_type_external_id_payload_hash_key;
ALTER TABLE ip_raw_events ADD CONSTRAINT ip_raw_capture_unique UNIQUE(source,event_type,external_id,payload_hash,collected_at);
-- Even direct writes cannot create a relation without a durable source.
ALTER TABLE ip_entity_relations ADD COLUMN source_event_id uuid REFERENCES ip_raw_events(id);
UPDATE ip_entity_relations r SET source_event_id=(SELECT source_id FROM ip_relation_evidence e WHERE e.relation_id=r.id ORDER BY created_at,id LIMIT 1);
ALTER TABLE ip_entity_relations ALTER COLUMN source_event_id SET NOT NULL;
CREATE INDEX ip_relation_source_event ON ip_entity_relations(source_event_id);
