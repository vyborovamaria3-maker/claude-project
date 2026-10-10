CREATE TABLE ip_audit_log (
 id uuid PRIMARY KEY,
 actor text NOT NULL,
 action text NOT NULL,
 entity_id uuid REFERENCES ip_entities(id),
 payload jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ip_audit_log_created ON ip_audit_log(created_at DESC);
CREATE INDEX ip_audit_log_action ON ip_audit_log(action,created_at DESC);
CREATE INDEX ip_audit_log_entity ON ip_audit_log(entity_id,created_at DESC) WHERE entity_id IS NOT NULL;
