-- A user may have at most one ACTIVE subscription row. Application code serializes
-- activation on the owning User row; this partial unique index is the final guard.
-- Fail closed if two unexpired ACTIVE rows already exist so an operator can
-- reconcile entitlement dates instead of silently choosing one.
UPDATE "Subscription"
SET "status" = 'EXPIRED'
WHERE "status" = 'ACTIVE'
  AND ("endsAt" IS NULL OR "endsAt" <= CURRENT_TIMESTAMP);

DO $$
BEGIN
  IF EXISTS (
    SELECT "userId"
    FROM "Subscription"
    WHERE "status" = 'ACTIVE'
    GROUP BY "userId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'subscription_active_duplicates_require_operator_reconciliation';
  END IF;
END $$;

CREATE UNIQUE INDEX "Subscription_one_active_per_user_idx"
  ON "Subscription"("userId")
  WHERE "status" = 'ACTIVE';
