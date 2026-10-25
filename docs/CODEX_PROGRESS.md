PROJECT: X Collector Runtime v2

## PR #127 — локальная приёмка и производительность V2

V2 plan/queue EXPLAIN (2026-10-20): statuses reconciled with Windows acceptance and CI f0627c6. SQL-only disposable *_test benchmark: 200004 synthetic jobs / 100 accounts; mixed 35–42 ms with manual_due index, manual-first before LIMIT verified. All-accounts-busy and all-agent-quotas-exhausted exceeded 15 s. A 10004-job diagnostic shows 4000 repeated quota aggregates before eligibility rejection. V2-05 performance gate remains open; runtime SQL unchanged. See x-collector/docs/QUEUE_EXPLAIN_V205_20261020_RU.md. No working DB/keys, Worker, X or merge used.

V2-05 quota optimization (2026-10-20): materialized per-account eligibility plus additive attempted-time partial index; hashed membership retains manual-first/config exemption and all account/breaker guards. Same 200004-job fixture: mixed 2–19 ms, busy 53.449 ms, exhausted quota 54.555 ms (both previously >15 s); 100 quota aggregates / 100 accounts, pause/busy zero. Targeted regression catches old 250 aggregates / 12 accounts; full 368 unit + 13 PG tests, typecheck/lint/build/native PostgreSQL pass. claim/leases/send-boundary/dedup unchanged. Only disposable *_test DB; no working keys/DB, live X or merge. See QUEUE_EXPLAIN_V205_20261020_RU.md.


PR #68 merge integration (2026-10-18): preserve canonical Alchemy history and Settings V2 transport/monitoring; forensic coverage and per-request collection ledger use separate explicit schemas so #65 cache rows survive unchanged. No automatic Helius fallback. Fence success/failure/budget-release by lease token and expiry; retain raw inventory evidence and unknown execution. Offline settings/forensic/FIFO/API/legacy-database regressions cover integration; authoritative PnL remains unavailable for incompletely decoded raw history.

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
# PR #68 local review (2026-10-15)

Reproduced false verified PnL for a 1e-12 unmatched sale; fixed both FIFO implementations and absolute token/native balance tolerances. Fixed missing wallet attribution in API activities, hidden seed-only trades, obsolete UI request handling, production evidence authorization and old decoder revision fencing. Offline API regression uses real SQLite and the transpiled route; tiny quantity, insufficient basis, token mismatch and one-lamport mismatch cases are in CI analysis tests. Rebuild local forensic/DEX projections with the existing offline CLI to populate the new revisions; no provider requests or automatic merge are required.


TG Collector PR #71 review (2026-10-16): fixed SOCKS transport selection, proxy endpoint credential isolation and login proxy usage, page-boundary Stop and guarded claims, delayed retry preservation, lock-loss termination, active-only graph rebuild and additive active-counter repair. Fixed browser 127.0.0.1 same-origin handling and graph edge identity. Local checks: 28 collector tests with isolated PostgreSQL 16, strict typecheck, 8 frontend access/proxy tests, frontend typecheck/build, lint with existing warnings, production dependency audit (zero vulnerabilities), current/history secret scans. Live Telegram accounts and proxy handshakes were not exercised. Latest-head GitHub CI remains the final confirmation.


TG Collector local UI connection (2026-10-17): Settings and Admin use the live collector database and an optional signed, origin-bound HttpOnly browser session, enabled only for the explicitly configured loopback development origin. No server token or Telegram credentials enter client props/storage. Verified against the running local app: 5 real messages, live worker, Settings Stop shared with Admin Start, reload without key entry, blocked cross-origin requests, and graph endpoint access. Added 3 session security tests (11 access/proxy/session tests total) and a live UI smoke script. Original TGInvite session remains separate.
PR #65 reconciliation follow-up (2026-10-17): missing-trade detection uses all stored signatures for the mint even when detailed trade auditing is limited. An extra row detects actual truncation, avoiding a false limit warning at the exact row count. SQLite CLI fixtures verify both cases and byte-for-byte source preservation; included in blockchain:test and the fast workflow. No trade.db in the PR checkout; inspected local legacy databases lack chain_seed_events. Real evidence reconciliation requires a consistent trade.db backup with token_trades and gzip chain_seed_events (include WAL safely), then run the read-only CLI for a populated mint. No live provider requests or collection performed.

PR #65 targeted evidence loader (2026-10-17): added bounded existing-signature planning (read-only by default), explicit --execute getTransaction retrieval, verified SQLite WAL-aware backup and additive transactional schema preparation. Offline fixtures cover backup preservation, migration idempotency, RPC null/failure/mismatched signature handling and restart deduplication. Live Alchemy remains untested and was not requested.

Local preparation verified: POTAPoff-current trade.db backed up with SQLite online backup and quick_check, then migrated additively. Original ten fields across all 8,499 trades match the backup by SHA-256; all five new columns remain NULL. Actual CLI plan selected 10 signatures without network; reconciliation runs and honestly reports zero raw events. Backup and preparation report are local artifacts, not committed.

PR #65 routed BUY attribution (2026-10-17): saved finalized transaction 127nj1U...EAXBH6 proves signer/funder 6Tewbk...FPS7v receives 259409450281 raw tokens through zero-net ARu4n5...T5SZn. Added a conservative offline resolver requiring successful matching execution, a sole positive signing/paying recipient, matching amount, ordered pool-to-intermediary-to-recipient checked transfers and matching SOL payment to the pool. Atomic repair retains the complete previous row and proof in chain_trade_attribution_repairs. Corrected exactly one local token_trades.trader; amounts/source unchanged. All 10 loaded trades now reconcile without detected mismatch; historical coverage and existing derived analytics caches remain unverified. No network requests or bulk collection. Regression uses the actual public transaction and covers refusal, audit preservation, and transactional rollback.

PR #65 live Alchemy audit (2026-10-17): eight bounded history RPCs (two initial failures, six successful after fixes), no bulk collection or writes of audit pages to the user's live DB. getTransactionsForAddress requires maxSupportedTransactionVersion=0 and returns data[]; fixed both live blockers and retained public response fixtures. Token and wallet recent/backfill/restart paths persisted four unique evidence rows in isolated SQLite, advancing cursors with completeness=false. Native SOL transfers must not become SPL inventory rows; failed/unknown execution produces no applied movements; per-account metadata is recovered before owner aggregation, unknown slots/times remain null, stuck/malformed pages fail without claiming exhaustion, and only the fee payer's SOL delta is adjusted for fee. Offline replay tests cover these paths. Remaining confirmed limitation: all ten saved swap transactions and the sampled live swaps produce zero normalized trades because current conservative txsToTrades rejects multiple-owner mint deltas; full swap decoding and authoritative PnL remain incomplete. Live continuity, reorg watching, account-wide completeness, sustained concurrency/load, real 429 recovery, and all SPL mint/burn variants are not established by a bounded sample.
Blockchain Settings V2 validation: offline settings/import/RPC contracts, seed persistence/analytics tests, analysis/security regressions, strict TypeScript and Next.js production build pass. Full ESLint: exit 0, 345 warnings. Private RPC and deployed operator/browser acceptance remain environment-dependent; no paid provider requests were used for these tests.


PR #62 CI repair (2026-10-18): reconciled with current main, retaining the strict main secret scanner. Cancellation remains idempotent for cancelled jobs while reserved/finalized invitations remain non-cancellable; added four HTTP regressions. Webhook setup regression now expects both verified join requests and explicit private /join messages. Fixed Python lint and SQLAlchemy result tuple typing. No running TGInvite process, session, credentials, webhook or production database was touched. Main release-image and X/Intelligence checks passed; production deploy and scheduled backup remain blocked by SSH host-key mismatch, which was not bypassed.


V2-08 Windows offline acceptance (2026-10-19, PR #127): dedicated loopback PostgreSQL *_test cluster, mocked X, real Worker heartbeat/restart and Next UI/API checks. Fixed autopost statistics SQL day alias, unknown-state UI, stale metric errors, and migration ledger lookup leaking through search_path. Added native/PGlite and Playwright regressions. Test-only key rotation/rollback and pg_dump/restore verified; no live X, real credentials, working DB changes or main merge. See x-collector/docs/V2_08_LOCAL_ACCEPTANCE_20261019_RU.md.
TG crypto discovery (2026-10-19): added opt-in migration 016, persistent keyword/query/addition/source budgets, sequential public contacts.Search on the existing singleton worker, atomic source + job creation, global Stop/FloodWait handling and operator deletion tombstones. Control Center now edits keywords/limits and shows public discovery results via its authenticated server bridge. Tests include real disposable PostgreSQL budgets, Stop during RPC, paused/deleted source protection and account/session errors; no original TGInvite session is used.

Automatic discovery keywords now come from the existing Twitter database through a
bounded read-only query. Live verification read 2000 posts and extracted seven crypto
topics; the first Telegram search found eight eligible sources and connected three
within the daily budget. Original TGInvite session files were unchanged.


Pump.fun discovery adds explicit mint/ticker inputs, a provider-reported historical
market-cap threshold and bounded queries. Missing ATH is excluded; upstream failure
is visible without blocking Twitter discovery. Live main refresh verified a fresh
Twitter-derived `solana` query found new sources and collected 98 messages from one
new channel. Pump.fun returned HTTP 403 locally, so successful live ATH retrieval
remains unverified. Original TGInvite session/proxy hashes remained unchanged.


Pump 403 diagnosis: all tested Pump API hosts return Cloudflare's blocked page.
Added independent exact-ticker/contract lookup and CoinGecko historical-cap evidence,
strict Pump category validation, durable cache, primary backoff and bounded deadlines.
Live PNUT mint and ticker both verified a $57.84M historical cap; bounded history is
labeled as a lower bound on lifetime ATH. Regression tests cover fake/wrong contracts,
other-chain/partial ticker matches, current versus historical data and 403 fallback.


Public message discovery now distinguishes actual unique posts from public sources.
Adds bounded pagination, exact term matching/dedup, canonical evidence/rollups and
reaction snapshots. Matched channels and public linked discussion groups opt into
complete available history through the existing resumable queue, removing the
initial-500 cutoff for those sources. Private discussions and source limits remain
visible. Live account rejected full-text search with PREMIUM_ACCOUNT_REQUIRED;
explicitly labeled free public-search/history modes continue without Stars payment.

Live collection exceeded 89000 canonical messages with 217 unique PNUT term matches
across 12 public sources; more than 9000 posts had observed reactions. No public linked
discussion was found among the inspected channels (one private/unavailable); real
discussion ingestion remains unverified, while public linking/queue tests pass.


Expanded no-Premium discovery adds public preview pages and candidate links from
Twitter/verified posts. Only real Telegram-verified matching posts enter mention
counts; public channels/groups share existing source budgets and full-history jobs.
Persistent page/RPC reservations, per-source term cursors and provenance are exposed
in native admin controls. Tests cover misleading snippets, public-group fallback,
deduplication, request budgets and Stop after resolution.

Live no-Premium verification confirmed 13 real Telegram posts from new AscendEX
announcement and Coinkolik channels through public previews, with full-history jobs
queued. A referenced public-chat lookup returned no matching/readable ordinary posts
in the initial check; no private joins or unverified mention counts were introduced.
Existing scheduled supervisor and local admin/frontend were restarted after they
were found stopped; original TGInvite files were preserved.

ARCH-06 PR #150 continuation (2026-10-20): preserve available pre-hash SQLite RAW snapshots on upgrade/replay, enforce append-only archive writes, reject mixed RPC result/error envelopes and label offline receipt provenance unverified. Synthetic regressions added for upgrades/rollback/mutations and supported inter-wallet mint/slot/time disagreement. See docs/architecture/ARCH_06_INTEGRITY_AUDIT_FIXES.md for verification and remaining provenance/finality/PnL blockers.

ARCH-06 RPC provenance preparation (2026-10-20, Draft #150): offline Ed25519 witness verification with out-of-band endpoint/cluster pins, exact RPC exchanges, bounded clocks and mandatory injected atomic challenge consumption for acceptance. Synthetic tests only; no acquisition, secret loading, database or API promotion. See docs/architecture/ARCH_06_RPC_PROVENANCE.md.

ARCH-06 challenge persistence (2026-10-20, Draft #150): explicit dedicated SQLite store persists hashed nonces and immutable event/source/key/cluster bindings, with autocommitted conditional consumption, independent expiry clock and no reset/purge fallback. Temporary-file tests cover process restart/lost ACK, concurrent connections, lock failure and persistent replay refusal; signed verifier adapter integration tested. No live DB/RPC or API confidence change. See docs/architecture/ARCH_06_RPC_PROVENANCE.md.

ARCH-06 recovery revocation (2026-10-20, Draft #150): challenge schema v2 requires an independently pinned recovery generation, explicit compare-and-rotate recovery and generation-fenced issuance/consumption. Old rows are retained but ineligible; v1 opens fail closed until explicit recovery migration. Temporary snapshot rollback tests include valid signed-package replay, stale handles and restart. Silent same-generation rollback/external-pin rollback cannot be detected automatically. See docs/architecture/ARCH_06_RPC_PROVENANCE.md.

ARCH-06 persistent recovery authority (2026-10-20, Draft #150): separate dedicated SQLite control file generates/retains epochs and active/recovering state; managed issue/consume holds the authority gate through challenge commit. Restart-safe finish handles a crash between generation change and SQLite recovery, or after SQLite commit before authority activation. Temporary process-failure/rollback/signed-replay tests added. Reviewed the four latest prior commits; fixed known generation reuse in low-level recovery. No live DB/RPC/main changes; whole-authority rollback remains outside local-file guarantees.

ARCH-06 independent rollback anchor (2026-10-20, Draft #150): optional explicit CAS witness pins head/sequence for anchored authorities and advances before each managed issue/consume, detecting a joint two-DB rollback even within one epoch. Interrupted commits block serving; explicit acknowledged-anchor recovery rotates/revokes. Temporary snapshots and child-process crashes tested. Local reference witness must be held outside both rollback domains; whole-host/all-three rollback remains outside guarantees. See docs/architecture/ARCH_06_RPC_PROVENANCE.md.
Multi-owner swap decoding (2026-10-18): added a conservative Pump.fun TradeEvent decoder for saved Alchemy jsonParsed evidence. It validates the canonical program invocation stack/discriminator, exactly one mint event, a unique signing end-user with matching net token amount/direction and opposing pool, and the checked-transfer path through protocol user within a Pump-containing outer instruction. Router users/pools are not attributed as traders. Native quote is the emitted pool execution amount (excludes router fees/tips), not a fee-payer balance guess. Non-SOL settlement requires matching quote-token delta and same-route transfer; the observed USDC sell keeps quoteMint/quoteAmount and amountSol=priceSol=0 without inventing a conversion. Ten retained real transactions decode to 5 BUY/5 SELL and reconcile cleanly in offline fixtures, including collector and wallet-cache persistence. No live API, bulk collection, canonical DB rewrite, or main mutation. Unknown DEX, split fills, non-signing recipients, multiple mint swap events, unsafe numeric ranges, and ambiguous evidence remain unsupported; decoderCoverage remains swap_only and PnL is not authoritative.

Four saved route cases (2026-10-21): quote transfer reconciliation now checks the complete SPL wallet ledger, then records only the Pump-containing route debit as quoteAmount; quoteWalletDeltaRaw/quoteRouteDeltaRaw/quoteExternalDeltaRaw retain the distinction without calling unrelated external transfers fees. Three USDC BUY route amounts are 32.05, 10.95111 and 200 (wallet total debits 33, 11.90111 and 202). The pinned canonical router SwapTob ABI (program proVF..., discriminator aa2955b184501f35, 57-byte observed layout) supports the retained split-output BUY: destination account binds recipient djyk..., signed source owner GLJP... funds it, net 332461.558363 target tokens are received, and 3288.301558 tokens go to the other recorded recipient. Full transfer conservation/order, account ownership, one Pump event, and both output deltas must match. fundedBy/grossTokenAmountRaw/tokenDeductions retain provenance; the recipient is not inferred from largest balance or fee payer. Actual four public transactions and negative mutations are offline regression fixtures, including immutable evidence and missing/external transfer checks. Source collector remains raw-only; DB replay is explicit, backed up and audited. No Alchemy requests or main changes.

WXMR settlement (2026-10-22): zero legacy SOL in Pump TradeEvent is accepted only with the existing exact target transfer/unique recipient proof plus opposing WXMR pool cash flow (12 decimals). End-user settlement stays in the actual quote token; temporary wrapped-SOL ownership requires explicit SPL account initialization. Missing quote proof never yields a zero-priced swap. Exact quoteAmountRaw is retained; protocolAmountSol is absent when no native protocol price exists. Eight retained MBC transactions cover v0/v1/legacy and native/USDC/WXMR routes with failure mutations. Quote summaries keep currencies separate, PnL NULL, and explicit unavailable status on legacy non-null SOL cache placeholders. Offline replay of 869 saved MBC events confirms 602 swaps (386 BUY/216 SELL, 196 wallets); 147 failed and 120 remaining successful transactions stay excluded. No RPC or main changes; discovered-address exhaustion does not establish complete token history.

MBC remaining swaps (2026-10-22): offline replay now proves all 702 single Pump TradeEvents from 869 saved transactions (446 BUY/256 SELL, 219 recipients). The 100 added rows are 60 BUY/40 SELL; 602 previous canonical rows remain unchanged. Link separate conversion instructions only by ordered flows through shared owned WXMR accounts and a conserved full wallet ledger. Keep the full WXMR quote for partial conversions; never price the whole trade using only converted SOL proceeds. Retain dust, route receipts, forwarded quote amounts and external debits distinctly. Initial supply minting is accepted only into a newly created non-signing pool with exact mint-minus-trade balance. A pinned 56-byte router layout proves the two-deduction output; a unique exact two-hop checked transfer proves a funded non-signing recipient without an inferred router ABI. Account for explicit native deposits plus syncNative in the wrapped-token ledger. Twelve real fixtures and negative mutations cover these paths and duplicate-group prevention. The 147 failed transactions and 20 successful events without a matching Pump TradeEvent stay outside canonical trades. Backed-up local replay and quote/counter cache refresh are offline; history completeness and authoritative PnL remain unproven.

Three MBC SELL review (2026-10-22): two rejected transactions are proven intermediate pool legs: the signer sells another mint into its upstream Pump pool, and that pool sends MBC directly into the next Pump pool. They remain raw observations and are explicitly classified, not manufactured wallet MBC SELLs. The third is a pinned 65-byte ExecuteLimitOrder (program 6Vo..., discriminator 34213c1e2f642816): maker VArQ... receives 98.809715 USDC for 8916909.180178 MBC from custody authority 2L8U...; executor 64fc... receives a separate 1.008160 USDC fee from gross 99.817875. Unique checked target transfer, opposing same-pool quote conversion, full custody/beneficiary/executor ledgers and output conservation must match. Reconciliation rebuilds the proof from raw evidence before recognizing custody attribution; supplied flags cannot bypass ownership/direction checks. Three actual fixtures and tampered proof/fee/recipient regressions are offline. No new RPC, FX conversion, or main changes.
# 2026-10-22: Alchemy token/creator graph discovery

- Fixed raw Alchemy create_v2 discovery using the saved MBC launch: creator comes
  from matching instruction arguments and Pump CreateEvent, not fee payer.
- Raw successful SPL pre/post owners now enter the existing wallet candidate
  queue when enhanced swap/transfer summaries are absent. Pool authorities remain
  candidates, never automatically traders or ordinary wallets.
- Existing durable creator/token/wallet waves are reused; no graph workers or
  production database migrations added. Unsupported creation layouts and token
  history gaps remain partial; known creator launches are not an exhaustive count.
- Regression uses the real saved receipt, malformed/failed proof rejection and
  in-memory graph replay. No Alchemy calls or production writes.

2026-10-22 live expansion follow-up: after a validated 9.43 GB SQLite backup,
the corrected discovery/queue schema was connected to the real database. Creator
history exposed 11 initiated launches: 10 matching MBC's event creator plus
Gracias Messi with a distinct event creator. Support the retained 43-byte
create_v2 tail and record requested creator, event creator and initiator
separately. Follow initiated tokens as separately labeled edges; never assign
their event creator to the initiator. Retained live receipt and negative binding
tests guard the distinction. Collection checkpoints/request ledger and detailed
coverage reports live with the task artifacts; history exhaustion is not proof
of complete swap decoding or globally exhaustive creator discovery.

2026-10-23: fixed three negative-final-SOL SELL receipts in BoJack (two) and Gracias Messi (one). Added exact native ledger proof and three retained real fixtures with adversarial regression cases. blockchain:test, blockchain:integration-test and strict TypeScript checks pass. Production replay uses a validated online snapshot and a short transaction; only two affected wallet aggregates and quote/cache projections refresh while raw background collection continues. MBC counts remain unchanged. No new RPC for investigation/replay, no main changes.

2026-10-23 dependency audit: repaired the production audit gate by locking Next.js 16.4.2 with matching ESLint configuration, sharp 0.35.5 and TOML 5.0.1. npm audit --omit=dev --audit-level=high passes with 0 high/critical findings; 20 moderate findings remain. Existing local BigInt protection is retained. Dependency installation and compatibility checks use a separate worktree so the active raw collector and production database remain available.

2026-10-23 final audit follow-up: the same vulnerable Next.js release also blocked subscription-service-security. Updated only that web workspace's Next.js/ESLint declarations and root lockfile to 16.4.2; its unchanged npm-audit-policy now reports no high/critical findings. On the isolated Windows installation, Anchor/TOML, Solana SDK/SPL, safe BigInt, native SQLite and sharp smoke checks pass, followed by blockchain:test and blockchain:integration-test. GitHub also passed the Solana audit, collector suites, TypeScript and application build. Production collection remains on its existing running environment; observed Alchemy timeout task records are separate from this dependency refresh.
