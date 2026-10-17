PROJECT: X Collector Runtime v2

PR #65 review (2026-10-17): fence seed persistence and failure updates by the claimed lease; commit evidence, projections, cursors and wallet history in one SQLite transaction. Failed Helius transactions remain raw evidence but produce no token/wallet trades. Offline regressions cover stale-worker success/error, projection rollback and wallet-status rollback; the fast seed workflow runs these checks.

CURRENT PHASE: Runtime reliability and collection efficiency; full master prompt not complete.

Laptop throughput (2026-10-14): opt-in X_SEARCH_HTTP_COMPAT uses pinned SDK POST SearchTimeline while retaining legacy onBatch/history filters and numeric list/history watermarks. Each page reserves the shared account quota, HTTP provenance is distinct, and proxy-less accounts are excluded. Live replacement cursor instructions are normalized; a strictly validated top/bottom cursor-only SearchTimeline response ends available indexed results (not exhaustive X coverage). History producer capacity follows max_browser_accounts rather than hardcoding one. Explicit bounded xactions:refresh updates metadata through a leased proxy, without background calls. Local laptop policy permits two workers; platform rate limits remain enforced.

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

PR #65 reconciliation follow-up (2026-10-17): missing-trade detection uses all stored signatures for the mint even when detailed trade auditing is limited. An extra row detects actual truncation, avoiding a false limit warning at the exact row count. SQLite CLI fixtures verify both cases and byte-for-byte source preservation; included in blockchain:test and the fast workflow. No trade.db in the PR checkout; inspected local legacy databases lack chain_seed_events. Real evidence reconciliation requires a consistent trade.db backup with token_trades and gzip chain_seed_events (include WAL safely), then run the read-only CLI for a populated mint. No live provider requests or collection performed.
