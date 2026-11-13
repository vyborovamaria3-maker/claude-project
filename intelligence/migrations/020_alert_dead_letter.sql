-- Additive: terminal dead-letter delivery status for token alerts.
-- dispatch-telegram-alerts previously left alerts as 'open' after the retry
-- budget was exhausted, so they were silently dropped from both the claim
-- query and operator dashboards. Extend the status domain and migrate rows
-- that were already stuck past the retry budget.
ALTER TABLE token_alerts
  DROP CONSTRAINT token_alerts_status_check;
ALTER TABLE token_alerts
  ADD CONSTRAINT token_alerts_status_check
  CHECK (status IN ('open','sending','delivered','acknowledged','resolved','dead_lettered'));

-- Historical rows that exhausted delivery_attempts while remaining 'open'
-- were unclaimable; convert them to the explicit terminal state.
UPDATE token_alerts
SET status = 'dead_lettered'
WHERE status = 'open'
  AND delivery_attempts >= 10;

-- The history trigger mirrors every status transition, so its own status
-- domain must accept the terminal state too.
ALTER TABLE token_alert_status_history
  DROP CONSTRAINT token_alert_status_history_status_check;
ALTER TABLE token_alert_status_history
  ADD CONSTRAINT token_alert_status_history_status_check
  CHECK (status IN ('open','sending','delivered','acknowledged','resolved','dead_lettered'));
