-- Entity resolution v2: aliases and evidence-backed identity candidates.
CREATE TABLE ip_entity_aliases (
 id uuid PRIMARY KEY,
 entity_id uuid NOT NULL REFERENCES ip_entities(id) ON DELETE CASCADE,
 alias text NOT NULL,
 alias_type text NOT NULL,
 source text NOT NULL,
 confidence double precision NOT NULL CHECK(confidence BETWEEN 0 AND 1),
 metadata jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ip_entity_aliases_lookup ON ip_entity_aliases(alias,alias_type);

CREATE TABLE ip_identity_candidates (
 id uuid PRIMARY KEY,
 entity_a uuid NOT NULL REFERENCES ip_entities(id) ON DELETE CASCADE,
 entity_b uuid NOT NULL REFERENCES ip_entities(id) ON DELETE CASCADE,
 match_type text NOT NULL,
 confidence double precision NOT NULL CHECK(confidence BETWEEN 0 AND 1),
 evidence_json jsonb NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','CONFIRMED','REJECTED')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ip_identity_candidates_status ON ip_identity_candidates(status);

CREATE TABLE ip_identity_reviews (
 id uuid PRIMARY KEY,
 candidate_id uuid NOT NULL REFERENCES ip_identity_candidates(id) ON DELETE CASCADE,
 decision text NOT NULL CHECK(decision IN ('CONFIRMED','REJECTED')),
 reviewer text,
 metadata jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ip_identity_reviews_candidate ON ip_identity_reviews(candidate_id);
