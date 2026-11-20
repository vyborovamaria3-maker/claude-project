-- Additive: terminal dead-letter delivery status for token alerts.
-- dispatch-telegram-alerts previously left alerts as 'open' after the retry
-- budget was exhausted, so they were silently dropped from both the claim
-- query and operator dashboards. Extend the status domain and migrate rows
-- that were already stuck past the retry budget.
--
-- Idempotent: the constraint swap drops and re-adds the same named
-- constraints and the conversions below only touch rows still outside the
-- terminal state, so re-running this file after a partially applied attempt
-- converges to the same result without duplicates.
DO $$
BEGIN
  ALTER TABLE token_alerts
    DROP CONSTRAINT IF EXISTS token_alerts_status_check;
  ALTER TABLE token_alerts
    ADD CONSTRAINT token_alerts_status_check
    CHECK (status IN ('open','sending','delivered','acknowledged','resolved','dead_lettered'));

  -- The history trigger mirrors every status transition, so its own status
  -- domain must accept the terminal state too.
  ALTER TABLE token_alert_status_history
    DROP CONSTRAINT IF EXISTS token_alert_status_history_status_check;
  ALTER TABLE token_alert_status_history
    ADD CONSTRAINT token_alert_status_history_status_check
    CHECK (status IN ('open','sending','delivered','acknowledged','resolved','dead_lettered'));
END $$;

-- Historical rows that exhausted delivery_attempts while remaining 'open'
-- were unclaimable; convert them to the explicit terminal state.
UPDATE token_alerts
SET status = 'dead_lettered'
WHERE status = 'open'
  AND delivery_attempts >= 10;

-- Rows left stuck in 'sending' by a dispatcher crash between the claim
-- (which already incremented delivery_attempts) and the terminal update are
-- equally unclaimable at the exhausted budget. Convert them to the terminal
-- state only after their claim lease has expired: the dispatcher treats a
-- 'sending' row as stale after 10 minutes, so an in-flight attempt is never
-- dead-lettered prematurely. delivery_attempts is preserved.
UPDATE token_alerts
SET status = 'dead_lettered'
WHERE status = 'sending'
  AND delivery_attempts >= 10
  AND delivery_attempted_at < NOW() - INTERVAL '10 minutes';
