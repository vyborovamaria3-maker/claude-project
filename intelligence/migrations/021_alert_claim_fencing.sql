-- Additive: fencing token for alert delivery claims and an operator-review
-- status for ambiguous outcomes.
--
-- Why: the Telegram Bot API provides no idempotency key, so a dispatcher
-- crash between the outbound send and the database ACK cannot be proven
-- delivered or not delivered by the database alone. The previous claim
-- scheme fenced terminal writes only with delivery_attempts, which is not
-- unique per claim: a stale worker could pass the guard while another
-- worker owned the row, and the outbound send happened after the claim
-- committed. This migration gives every claim a unique claim_token and adds
-- an explicit terminal-pending review status instead of silently retrying
-- ambiguous outcomes.
--
-- Honest delivery semantics (see also dispatch-telegram-alerts.mjs):
--   * Workers never exceed the 10-attempt automatic retry budget.
--   * Live concurrent workers cannot double-send: claims are exclusive
--     (FOR UPDATE SKIP LOCKED), terminal writes are fenced by the unique
--     per-claim claim_token, and each worker atomically renews its lease
--     immediately before the outbound call - a worker that lost ownership
--     affects zero rows there and never reaches the API.
--   * A crash AFTER a successful send but BEFORE the ACK, a worker
--     stalling longer than a full lease window between the renewal and
--     the fetch, or an HTTP 5xx/408 response from the upstream (which
--     does not prove the message was not processed) can still produce
--     one duplicate or an unresolved delivery attempt. These outcomes
--     are at-least-once, bounded by the 10 minute lease, and parked in
--     'needs_review' when the upstream cannot prove non-delivery. This
--     is NOT exactly-once delivery - the Telegram Bot API has no
--     idempotency key - and the residual window is reported to the
--     operator, not hidden.
--   * Ambiguous outcomes (network timeout, unknown transport failure,
--     HTTP 5xx/408) are parked in 'needs_review' and never retried
--     automatically. Only 4xx rejections prove the request was received
--     and refused without a send, so only they are retried.
--   * Rows that were already stale and exhausted BEFORE this migration
--     shipped were terminalized by migration 020 as an explicit
--     failure-assumption (they remain operator-visible and reprocessable
--     in 'dead_lettered'); this migration only re-classifies rows that
--     are still 'sending'.
--
-- Idempotent: the column add and constraint swap converge on re-run, and
-- the conversion below only touches rows still outside the terminal states.
DO $$
BEGIN
  ALTER TABLE token_alerts
    ADD COLUMN IF NOT EXISTS claim_token uuid;
  ALTER TABLE token_alerts
    DROP CONSTRAINT IF EXISTS token_alerts_status_check;
  ALTER TABLE token_alerts
    ADD CONSTRAINT token_alerts_status_check
    CHECK (status IN ('open','sending','delivered','acknowledged','resolved','dead_lettered','needs_review'));
  ALTER TABLE token_alert_status_history
    DROP CONSTRAINT IF EXISTS token_alert_status_history_status_check;
  ALTER TABLE token_alert_status_history
    ADD CONSTRAINT token_alert_status_history_status_check
    CHECK (status IN ('open','sending','delivered','acknowledged','resolved','dead_lettered','needs_review'));
END $$;

-- Rows stuck in 'sending' at or beyond the retry budget with an expired
-- lease cannot be safely auto-reclaimed (an automatic 11th send is
-- forbidden) and must not stay invisible either: park them for operator
-- review. The operator releases them back to 'open' (resets
-- delivery_attempted_at) only after checking the Telegram side.
UPDATE token_alerts
SET status = 'needs_review'
WHERE status = 'sending'
  AND delivery_attempts >= 10
  AND delivery_attempted_at < NOW() - INTERVAL '10 minutes';
