-- Temporal graph event history.
-- Keeps relation evolution without overwriting previous states.

CREATE TABLE ip_relation_events (
 id uuid PRIMARY KEY,
 relation_id uuid NOT NULL REFERENCES ip_entity_relations(id),
 event_type text NOT NULL,
 weight_delta double precision NOT NULL DEFAULT 0,
 confidence_delta double precision NOT NULL DEFAULT 0,
 metadata jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ip_relation_events_relation_time ON ip_relation_events(relation_id, created_at);
CREATE INDEX ip_relation_events_type ON ip_relation_events(event_type);
