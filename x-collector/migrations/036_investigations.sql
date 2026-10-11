CREATE TABLE ip_investigations (
 id uuid PRIMARY KEY,
 subject_entity_id uuid REFERENCES ip_entities(id),
 title text NOT NULL,
 status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','ACTIVE','CLOSED','ARCHIVED')),
 priority text NOT NULL DEFAULT 'NORMAL' CHECK(priority IN ('NORMAL','IMPORTANT','URGENT')),
 hypothesis text NOT NULL DEFAULT '',
 summary text NOT NULL DEFAULT '',
 created_by text NOT NULL DEFAULT 'agent',
 metadata jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 started_at timestamptz,
 closed_at timestamptz,
 CHECK(closed_at IS NULL OR started_at IS NOT NULL)
);
CREATE INDEX ip_investigations_status ON ip_investigations(status,updated_at DESC);
CREATE INDEX ip_investigations_subject ON ip_investigations(subject_entity_id) WHERE subject_entity_id IS NOT NULL;

CREATE TABLE ip_investigation_steps (
 id uuid PRIMARY KEY,
 investigation_id uuid NOT NULL REFERENCES ip_investigations(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('OBSERVATION','HYPOTHESIS','EVIDENCE','CONCLUSION','TASK')),
 content text NOT NULL,
 source_event_id uuid REFERENCES ip_raw_events(id),
 entity_id uuid REFERENCES ip_entities(id),
 confidence double precision NOT NULL DEFAULT 1 CHECK(confidence BETWEEN 0 AND 1),
 metadata jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ip_investigation_steps_investigation ON ip_investigation_steps(investigation_id,created_at);
