PROJECT: X Collector Runtime v2

CURRENT PHASE: Runtime reliability and collection efficiency; full master prompt not complete.

2026-10-16 PR69 follow-up: standalone history producer handles idle PostgreSQL
disconnects and startup outages with cancellable reconnect backoff, reacquires
its session advisory lock and resumes durable progress without replaying SQL
transactions. Regression tests cover lock competition, shutdown and fatal schema
errors; native PostgreSQL test terminates only a dedicated test backend.

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


TG Collector PR #71 review (2026-10-16): fixed SOCKS transport selection, proxy endpoint credential isolation and login proxy usage, page-boundary Stop and guarded claims, delayed retry preservation, lock-loss termination, active-only graph rebuild and additive active-counter repair. Fixed browser 127.0.0.1 same-origin handling and graph edge identity. Local checks: 28 collector tests with isolated PostgreSQL 16, strict typecheck, 8 frontend access/proxy tests, frontend typecheck/build, lint with existing warnings, production dependency audit (zero vulnerabilities), current/history secret scans. Live Telegram accounts and proxy handshakes were not exercised. Latest-head GitHub CI remains the final confirmation.


TG Collector local UI connection (2026-10-17): Settings and Admin use the live collector database and an optional signed, origin-bound HttpOnly browser session, enabled only for the explicitly configured loopback development origin. No server token or Telegram credentials enter client props/storage. Verified against the running local app: 5 real messages, live worker, Settings Stop shared with Admin Start, reload without key entry, blocked cross-origin requests, and graph endpoint access. Added 3 session security tests (11 access/proxy/session tests total) and a live UI smoke script. Original TGInvite session remains separate.
