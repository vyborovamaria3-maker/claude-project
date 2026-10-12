PROJECT: X Collector Runtime v2

CURRENT PHASE: Tested runtime/queue/account stabilization slice; full master prompt not complete.

COMPLETED:
- Audit/map and reusable real collector operation
- Worker lifecycle, cancellation, unique IDs, shutdown deadline
- Expiry/attempt/persistence fencing and shared account reservations
- Entity/result transaction repair; PostgreSQL rollback tests
- Classified retries, jitter, server delays, safe account intervention
- Bounded producers, DLQ read/replay, shared redacted logging
- Scheduler drain, diagnostic heartbeats, counter recovery
- Existing Docker collector profile and browser/CJS packaging
- Compatible Vue security upgrade

NEXT / REMAINING:
- Confirm live X behavior and permitted quotas on deployment
- Durable launcher process management/global circuit scope if needed
- Load, full monorepo security and archive retention review
- Decide Solana SDK major migration for four moderate advisories

VERIFICATION: See architecture/TEST_REPORT.md for final exact results. Source based on supplied ZIP, not substituted GitHub HEAD. No production-ready claim.

Review fixes: account-specific HTTP 401/403 and login/CAPTCHA failures now retry within the existing task attempt budget after account quarantine. Standalone search uses taskFailure codes for account state. SQL-backed regression verifies 401/403 quarantine, lease release, retry and completion through a second account.
