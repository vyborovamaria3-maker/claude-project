PROJECT: X Collector Runtime v2

CURRENT PHASE: Runtime reliability and collection efficiency; full master prompt not complete.

XActions merge preparation (2026-10-14): package the CJS HTTP loader and check compiled collector import in CI; enforce a total HTTP deadline across SOCKS negotiation and streaming. Local verification: 46 targeted tests, typecheck/build/compiled import passed. Live X response compatibility remains an activation gate; automatic three-list/history/discovery routing stays on Playwright, with no automatic engine fallback. Full regression and native PostgreSQL run in latest-head CI.

Collection efficiency: migration 039 adds durable per-list checkpoints, paginated search and incremental watermarks. Automated tasks can fall back to eligible collector accounts; quota waits preserve attempts. Fresh updates outrank historical backfill. Deadlines fail honestly with saved batches retained. Partial list pages can be retried from settings or the collection-status CLI. 190 tests and real PostgreSQL runtime integration passed. Local rollout preserved databases and encrypted sessions; live X pages are currently failing to load, so no claim of complete collection or measured throughput gain. See architecture/COLLECTION_EFFICIENCY.md.

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

Local runtime fixes: scheduler coalesces pending ticks and bounds concurrency with reserved DB query capacity. Additive migration 038 repairs overflowing day-duration constants in existing analytics function definitions and is idempotent. Real PostgreSQL integration exercises every initial scheduler tick with a five-connection pool and graceful shutdown. Local Celery Beat was recreated with synchronized broker credentials; credentials stay outside Git. Local Qwen is outside the user's provider API workflow.

Staged discovery: migration 040 adds an opt-in plan linking exactly three lists and a history run. Author/list completion gates historical topics and seven continuous discovery searches, including already queued tasks. Shared transactional account selection caps collector browser leases at one for a small VPS. Partial searches keep cursors and require an explicit retry. See architecture/STAGED_DISCOVERY.md. Validation: 191 collector tests, strict typecheck/build and real PostgreSQL runtime integration passed; live X completeness remains unconfirmed.
