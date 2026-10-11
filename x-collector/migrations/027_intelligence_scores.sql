-- Intelligence scoring layer.
-- Scores are derived analytics and do not replace raw observations.
CREATE TABLE ip_entity_scores (
 id uuid PRIMARY KEY,
 entity_id uuid NOT NULL REFERENCES ip_entities(id),
 influence_score double precision CHECK(influence_score BETWEEN 0 AND 1),
 authority_score double precision CHECK(authority_score BETWEEN 0 AND 1),
 trust_score double precision CHECK(trust_score BETWEEN 0 AND 1),
 risk_score double precision CHECK(risk_score BETWEEN 0 AND 1),
 activity_score double precision CHECK(activity_score BETWEEN 0 AND 1),
 calculation_version text NOT NULL DEFAULT 'v1',
 metadata jsonb NOT NULL DEFAULT '{}',
 calculated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(entity_id, calculation_version)
);

CREATE INDEX ip_entity_scores_influence ON ip_entity_scores(influence_score DESC);
CREATE INDEX ip_entity_scores_risk ON ip_entity_scores(risk_score DESC);
CREATE INDEX ip_entity_scores_entity ON ip_entity_scores(entity_id);
