-- Intelligence 2.2: a post-hoc backtest cannot establish an independent holdout.
-- Preregistration is a separate governance boundary and MUST predate the holdout.
CREATE TABLE IF NOT EXISTS signal_policy_preregistrations (
  policy_id UUID PRIMARY KEY,
  signal_version TEXT NOT NULL CHECK(length(signal_version) BETWEEN 1 AND 128),
  signal_name TEXT NOT NULL CHECK(signal_name ~ '^[a-z][a-z0-9_]{0,63}$'),
  threshold NUMERIC NOT NULL,
  horizon_hours INTEGER NOT NULL CHECK(horizon_hours BETWEEN 1 AND 720),
  code_revision TEXT NOT NULL CHECK(code_revision ~ '^[a-f0-9]{40}$'),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(signal_version,signal_name,threshold,horizon_hours,code_revision)
);
CREATE INDEX IF NOT EXISTS idx_signal_policy_lookup ON signal_policy_preregistrations
  (signal_version,signal_name,registered_at DESC);
ALTER TABLE signal_validation_registry ADD COLUMN IF NOT EXISTS policy_id UUID
  REFERENCES signal_policy_preregistrations(policy_id);

-- Registration time is DB-owned, not client-supplied. Policies cannot be
-- moved back in time or edited after publication.
CREATE OR REPLACE FUNCTION enforce_immutable_signal_policy() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    NEW.registered_at=clock_timestamp();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'signal_policy_immutable';
END
$$;
DROP TRIGGER IF EXISTS tr_signal_policy_immutable ON signal_policy_preregistrations;
CREATE TRIGGER tr_signal_policy_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON signal_policy_preregistrations
  FOR EACH ROW EXECUTE FUNCTION enforce_immutable_signal_policy();
