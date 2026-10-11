-- Advanced tag provenance and history layer
CREATE TABLE ip_tag_sources (
 id text PRIMARY KEY,
 name text NOT NULL
);

INSERT INTO ip_tag_sources(id,name) VALUES
('MANUAL','Manual assignment'),
('AI','AI classification'),
('RULE','Rule based classification'),
('GRAPH','Graph inference'),
('BLOCKCHAIN','Blockchain analysis')
ON CONFLICT DO NOTHING;

CREATE TABLE ip_entity_tag_history (
 id uuid PRIMARY KEY,
 entity_id uuid NOT NULL REFERENCES ip_entities(id),
 tag_id text NOT NULL REFERENCES ip_tags(id),
 source_id text REFERENCES ip_tag_sources(id),
 previous_confidence double precision,
 new_confidence double precision NOT NULL CHECK(new_confidence BETWEEN 0 AND 1),
 metadata jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ip_entity_tag_history_entity ON ip_entity_tag_history(entity_id,created_at);
CREATE INDEX ip_entity_tag_history_tag ON ip_entity_tag_history(tag_id,created_at);

ALTER TABLE ip_entity_tags
ADD COLUMN IF NOT EXISTS source_id text REFERENCES ip_tag_sources(id);

ALTER TABLE ip_entity_tags
ADD COLUMN IF NOT EXISTS confidence double precision DEFAULT 1 CHECK(confidence BETWEEN 0 AND 1);