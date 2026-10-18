PROJECT: X Collector Runtime v2

PR #65 merge validation (2026-10-18): preserve Settings V2 exports, imports and monitoring while routing Alchemy history through the shared persisted timeout/retry/rate/concurrency transport. UI checks Alchemy availability; generic RPC choices remain Intelligence-only. Mocked adapter tests exercise pause, batch size, 429 retry, request accounting and finished run status. Provider migration no longer clears validated wallet history on every initialization. Full swap decoding and authoritative PnL remain explicitly incomplete.

PR #65 review (2026-10-17): fence seed persistence and failure updates by the claimed lease; commit evidence, projections, cursors and wallet history in one SQLite transaction. Failed Helius transactions remain raw evidence but produce no token/wallet trades. Offline regressions cover stale-worker success/error, projection rollback and wallet-status rollback; the fast seed workflow runs these checks.
Blockchain Settings V2 (2026-10-15): based on main fa0b46f and PR #66, connected RU/EN controls to persisted SQLite settings, shared CLI/server rate/concurrency leases, bounded RPC retries/fallback and real XLSX import/history. Reused the prior seed engine and existing Intelligence token_trades/analytics rather than introducing a service. Backend superusers control shared settings; loopback development operator mode is explicit. Existing analysis/security regression, seed integration/failure tests and typecheck are checked with the new settings contracts; see solana-launcher/docs/BLOCKCHAIN_SETTINGS_V2.md. No automatic merge or production completeness claim.

CURRENT PHASE: Runtime reliability and collection efficiency; full master prompt not complete.

2026-10-16 migration/dependency hardening: scoped Solana SDK override to
jayson 5 removes vulnerable uuid 8 and stream-json without upgrading SDK APIs.
Migration ledger stores SHA-256; all applied hashes are checked before DDL.
Legacy hashes require explicit reviewed baseline, status remains read-only,
and the migration session itself holds the advisory lock. SQL files and
lib/trade/analytics* remain unchanged. Checksums detect source drift, not manual
database schema edits.

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

PR #65 reconciliation follow-up (2026-10-17): missing-trade detection uses all stored signatures for the mint even when detailed trade auditing is limited. An extra row detects actual truncation, avoiding a false limit warning at the exact row count. SQLite CLI fixtures verify both cases and byte-for-byte source preservation; included in blockchain:test and the fast workflow. No trade.db in the PR checkout; inspected local legacy databases lack chain_seed_events. Real evidence reconciliation requires a consistent trade.db backup with token_trades and gzip chain_seed_events (include WAL safely), then run the read-only CLI for a populated mint. No live provider requests or collection performed.

PR #65 targeted evidence loader (2026-10-17): added bounded existing-signature planning (read-only by default), explicit --execute getTransaction retrieval, verified SQLite WAL-aware backup and additive transactional schema preparation. Offline fixtures cover backup preservation, migration idempotency, RPC null/failure/mismatched signature handling and restart deduplication. Live Alchemy remains untested and was not requested.

Local preparation verified: POTAPoff-current trade.db backed up with SQLite online backup and quick_check, then migrated additively. Original ten fields across all 8,499 trades match the backup by SHA-256; all five new columns remain NULL. Actual CLI plan selected 10 signatures without network; reconciliation runs and honestly reports zero raw events. Backup and preparation report are local artifacts, not committed.

PR #65 routed BUY attribution (2026-10-17): saved finalized transaction 127nj1U...EAXBH6 proves signer/funder 6Tewbk...FPS7v receives 259409450281 raw tokens through zero-net ARu4n5...T5SZn. Added a conservative offline resolver requiring successful matching execution, a sole positive signing/paying recipient, matching amount, ordered pool-to-intermediary-to-recipient checked transfers and matching SOL payment to the pool. Atomic repair retains the complete previous row and proof in chain_trade_attribution_repairs. Corrected exactly one local token_trades.trader; amounts/source unchanged. All 10 loaded trades now reconcile without detected mismatch; historical coverage and existing derived analytics caches remain unverified. No network requests or bulk collection. Regression uses the actual public transaction and covers refusal, audit preservation, and transactional rollback.

PR #65 live Alchemy audit (2026-10-17): eight bounded history RPCs (two initial failures, six successful after fixes), no bulk collection or writes of audit pages to the user's live DB. getTransactionsForAddress requires maxSupportedTransactionVersion=0 and returns data[]; fixed both live blockers and retained public response fixtures. Token and wallet recent/backfill/restart paths persisted four unique evidence rows in isolated SQLite, advancing cursors with completeness=false. Native SOL transfers must not become SPL inventory rows; failed/unknown execution produces no applied movements; per-account metadata is recovered before owner aggregation, unknown slots/times remain null, stuck/malformed pages fail without claiming exhaustion, and only the fee payer's SOL delta is adjusted for fee. Offline replay tests cover these paths. Remaining confirmed limitation: all ten saved swap transactions and the sampled live swaps produce zero normalized trades because current conservative txsToTrades rejects multiple-owner mint deltas; full swap decoding and authoritative PnL remain incomplete. Live continuity, reorg watching, account-wide completeness, sustained concurrency/load, real 429 recovery, and all SPL mint/burn variants are not established by a bounded sample.
Blockchain Settings V2 validation: offline settings/import/RPC contracts, seed persistence/analytics tests, analysis/security regressions, strict TypeScript and Next.js production build pass. Full ESLint: exit 0, 345 warnings. Private RPC and deployed operator/browser acceptance remain environment-dependent; no paid provider requests were used for these tests.
