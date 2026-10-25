-- Preserve alert state transitions so the signals endpoint can answer as-of queries honestly.
CREATE TABLE IF NOT EXISTS token_alert_status_history (history_id BIGSERIAL PRIMARY KEY,
  alert_id BIGINT NOT NULL REFERENCES token_alerts(alert_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('open','sending','delivered','acknowledged','resolved')),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX IF NOT EXISTS idx_token_alert_status_history_asof ON token_alert_status_history(alert_id,changed_at DESC,history_id DESC);

-- Existing alerts only have a trustworthy status from migration time onward.
INSERT INTO token_alert_status_history(alert_id,status,changed_at)
SELECT alert.alert_id,alert.status,NOW() FROM token_alerts alert
WHERE NOT EXISTS (SELECT 1 FROM token_alert_status_history history WHERE history.alert_id=alert.alert_id);

CREATE OR REPLACE FUNCTION record_token_alert_status_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    INSERT INTO token_alert_status_history(alert_id,status,changed_at) VALUES (NEW.alert_id,NEW.status,clock_timestamp());
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO token_alert_status_history(alert_id,status,changed_at) VALUES (NEW.alert_id,NEW.status,clock_timestamp());
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS token_alert_status_history_trigger ON token_alerts;
CREATE TRIGGER token_alert_status_history_trigger AFTER INSERT OR UPDATE ON token_alerts
FOR EACH ROW EXECUTE FUNCTION record_token_alert_status_history();
