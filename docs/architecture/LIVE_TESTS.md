# LIVE_TESTS — TG Collector / Cross-source Intelligence

Audit register started **2026-10-22** on `audit/tg-collector-sprint0-20261022`. This file distinguishes **source inspection**, **offline tests** and **actual live validation**. No tests were executed as part of this documentation-only sprint-0 audit: all execution statuses below are `NOT RUN`. Historical README/CI claims are references to existing test infrastructure, not evidence that the *current head* is green.

## CI-only evidence — 2026-10-30

PR [#203](https://github.com/vyborovamaria3-maker/claude-project/pull/203), head `03aca7e25f3d66f0d39f6f8b279483eb8eb101cf`:

- 17 GitHub Actions workflows completed successfully; one conditional Security Lock Refresh workflow was skipped.
- [Frontend Quality CI](https://github.com/vyborovamaria3-maker/claude-project/actions/runs/41107335183) passed. Its Playwright log contains one `ANALYSIS_OVERVIEW_OK` run covering source values, missing/empty/error states, stale-mint protection, the 141-field report, mobile layout and explicit AI request only.
- [Social Analysis UI CI](https://github.com/vyborovamaria3-maker/claude-project/actions/runs/41107335055), [Security Gates](https://github.com/vyborovamaria3-maker/claude-project/actions/runs/41107335173) and [POTAPoff predeploy gate](https://github.com/vyborovamaria3-maker/claude-project/actions/runs/41107335084) passed.
- The on-demand regression suite reports 21 tests passed, 0 failed; it includes a source-level assertion that unified Analysis embeds `BlockchainAiReportPanel` in request-only mode.

**Classification:** OFFLINE / SYNTHETIC CI ONLY. No real X account, Telegram MTProto session, paid RPC, production database, production migration, live witness service or backup/restore operation was accessed. All external live-validation rows below remain `NOT RUN` until a separately approved run records the evidence required by this register.

## Verification matrix

| Component | Test method / entrypoint | Required environment | Status 2026-10-22 | Evidence / follow-up |
| --- | --- | --- | --- | --- |
| TG TypeScript | `cd tg-collector && npm ci && npm run typecheck` | Node 22; dependency install | NOT RUN | Capture stdout, Node version and exact SHA. |
| TG unit/integration | `cd tg-collector && npm test` | Disposable PostgreSQL; no real Telegram account | NOT RUN | Test suite includes `tests/*.test.ts` and `tests/integration/*.test.ts`. |
| Clean and upgrade migrations | `npm run migrate` against **disposable** clean and copied legacy fixtures; negative checksum test | Disposable, separately named TG PG database | NOT RUN | Never migrate laptop source DB as an audit probe. Verify schema_migrations checksums. |
| MTProto auth/session | `npm run smoke:mtproto` | User-owned dedicated Telegram test session, permitted public channel and explicit operator approval | NOT RUN | Account/network test is intentionally separate from CI. Never upload .tg-session/2FA or credentials. |
| History checkpoint/restart | Controlled stop mid-page, restart, verify cursor, source peer and coverage flag | Disposable TG database and public test source | NOT RUN | Include full-history plus live polling interleave. |
| Entity/evidence lifecycle | Offline backfill + `npm run analyze:refresh` on fixtures | Disposable TG database, worker stopped | NOT RUN | Confirm delete/edit/retraction and full vs partial coverage. |
| Token identity and ticker | Resolver fixtures; `npm run tokens:resolve -- --limit=...` only if explicitly approved | Offline fixtures first; network RPC may cost money | NOT RUN | Check `solana-mainnet`→`solana:<mint>`, invalid mint layouts and ambiguous tickers. |
| Duplicate posts/clusters | Integration test 100 normalized identical messages | Disposable PG dataset | NOT RUN | 100 observations, one exact-copy cluster, no inflation of independent signals. |
| Market snapshots | `npm run market:refresh -- --limit=...` | Approved DexScreener access; separate test DB | NOT RUN | Snapshot time/provider quality and rate limits; do not infer historical prices. |
| Market outcomes | `npm run market:outcomes -- --limit=...` | Fixture snapshots with known time coverage | NOT RUN | Assert pending/insufficient_data/complete, no future-leaking price substitution. |
| Velocity/first mentions | `npm run analyze:refresh` + SQL assertions | Disposable database with timestamped multi-channel fixtures | NOT RUN | 5m/15m/1h/6h/24h, proper event time, coverage status, `z_score` remains NULL until implemented. |
| Channel score | `npm run analyze:refresh` + SQL assertions | Sources with <5 and >=5 valid outcomes | NOT RUN | Composite NULL for insufficient samples, verify complete inputs and traceable contributing outcomes. |
| Backtest | `npm run backtest:run -- --from=2025-01-01 --test-start=2025-07-01 --to=2025-10-01` against a **synthetic** fixture | Disposable PG with known historical outcomes | NOT RUN | Holdout, no-peeking and source/outcome join tests; no profitability claim. |
| DB growth metrics | `npm run db:metrics` | Disposable PG | NOT RUN | Confirm snapshots/index sizes and runtime cost. |
| TG web/API | `solana-launcher/tests/tg-collector-graph-smoke.mjs` and local access tests | Local test Next.js and isolated TG DB | NOT RUN | Exercise graph evidence click-through, auth, localhost controls. |
| Cross-source canonical timeline | `npm --prefix intelligence run check` plus isolated token-timeline integration test | Node 22, disposable PG/SQLite, opt-in test flags | NOT RUN | Fixtures alone do not prove live X/TG/Blockchain verified-token emitters. |
| Worker failure/monitoring | Stop/restart test, FloodWait fixture, heartbeat age and queue inspection | Disposable TG DB, optional test Telegram account | NOT RUN | No bypassing Telegram limits. |
| Backup and recovery | `npm run backup` plus `npm run backup:verify` against disposable backup | Isolated DB, pg_dump/pg_restore/bash | NOT RUN | Verify off-host and restore separately when operator approves. |

## Required evidence for changing NOT RUN → PASSED / FAILED

For each run record:

- UTC time, branch and **full commit SHA**, worker/runtime version, command, fixture or anonymized source scope.
- Whether it was unit, integration, isolated DB, live Telegram, paid RPC, UI, or end-to-end.
- Exit code, sanitized log/CI URL, relevant row counts and expected vs actual assertions.
- Connection target identity (nonsecret DB name only); ensure no production mutation.
- Reviewer/owner, known coverage limits, observed failure and remediation PR.
- A test may be **PASSED offline** while the corresponding live validation stays **NOT RUN**. Do not collapse them.

## Safe execution order

1. Read-only source inspection and repository/CI status. Confirm local checkout matches audited commit.
2. Unit/typecheck checks, then disposable PostgreSQL migrations and integration tests.
3. Offline data fixtures for evidence, canonical links, outcomes, timing, baseline and scores.
4. Explicitly approved bounded external tests (MTProto, Solana RPC, DexScreener).
5. Controlled restart, delivery replay, backup/restore and UI tests.
6. Mark each independent test with actual results; publish aggregate readiness only after all required gates pass.

Related: [DATA_CONTRACTS.md](DATA_CONTRACTS.md), [KNOWN_GAPS.md](KNOWN_GAPS.md), [TG Collector README](../../tg-collector/README.md).


## Broader readiness evidence register — snapshot 2026-10-24

This is an **additional** inventory; it does not change the 2026-10-22 TG `NOT RUN` statuses above. `CI PASSED` is a separate verification dimension from `LIVE PASSED`. All external actions and production read/write tests listed here were **NOT RUN by this GitHub-only audit**.

| Component/gate | Offline or CI evidence actually observed | External/live status in this audit | Required next proof |
| --- | --- | --- | --- |
| X Collector code quality on `main` | [X Collector quality run](https://github.com/vyborovamaria3-maker/claude-project/actions/runs/40070070244) `success` for `c3e5e1a3...` (not latest `8f79ce92` head) | **NOT RUN** | Controlled read-only account observation, provenance, rate/recovery evidence; exact new run SHA. |
| X Autoposting v2 | PR [#127](https://github.com/vyborovamaria3-maker/claude-project/pull/127) merged; its description explicitly says no real X action | **NOT RUN** | Dedicated authorized X test account; publication/ambiguous-state/manual-review and no-duplicate outcome evidence ([#175](https://github.com/vyborovamaria3-maker/claude-project/issues/175)). |
| TG collector | Main contains [#164](https://github.com/vyborovamaria3-maker/claude-project/pull/164) documentation and TG tests/workflows; standalone TG execution rows above are NOT RUN | **NOT RUN** | Permitted dedicated MTProto test session, stable peer ID, history/checkpoint/retraction, sanitized evidence. |
| Chain evidence and token identity | Code and disposable/saved receipt fixtures; native-to-canonical adapter work in open [#165](https://github.com/vyborovamaria3-maker/claude-project/pull/165) | **NOT RUN** | Approved capped RPC read, mint-layout verification, finality/provenance, unknown operations and evidence coverage. |
| Intelligence synthetic cross-source delivery | Dedicated offline suites documented in [Intelligence README](../../intelligence/README.md); [PR #167 Intelligence CI](https://github.com/vyborovamaria3-maker/claude-project/actions/runs/40071746525) succeeded for PR head `f24e0e2d...` | **NOT RUN** | Verify three separate live producers, bounded supervised consumer, ACK-after-commit, timeline and retractions with logged proofs. |
| Security Gates on proposed PR #167 | [Run 40071746530](https://github.com/vyborovamaria3-maker/claude-project/actions/runs/40071746530): **FAILED** for legacy-miniapp and subscription-service dependency audits; other checked security jobs passed | **No prod audit executed by this review** | Fix latest candidate head, rerun whole gate, compare to branch main separately ([#171](https://github.com/vyborovamaria3-maker/claude-project/issues/171)). |
| Backup + restore / deploy trust | Historical 2026-10-19 SSH failures in [KNOWN_GAPS](KNOWN_GAPS.md) | **NOT RUN** | Verify host fingerprint correctly, isolated dump/restore, SQLite WAL-aware backup, recovery timing ([#172](https://github.com/vyborovamaria3-maker/claude-project/issues/172)). |
| End-to-end user query / pilot | Proposed in [ADR-0002](ARCHITECTURE_DECISIONS/0002-token-intelligence-mvp-focus.md) | **NOT RUN** | Authorized API/UI scenario then independent usability/pilot metrics ([#177](https://github.com/vyborovamaria3-maker/claude-project/issues/177), [#180](https://github.com/vyborovamaria3-maker/claude-project/issues/180)). |

### Completion rule (all components)

Never promote “not tested” based on a merge, test-name existence, synthetic fixture, screenshot or a passing job for another commit. For **each** real run, append dated evidence containing: full `sha`, exact UTC timestamp, tested branch/config, bounded scope, authorization/owner, sanitized log or Actions URL, DB identity without secrets, expected and actual result, recovery/retraction assertions, and reason for any `FAILED` or `BLOCKED`. The GitHub-only documentation audit makes **no live-pass claims**.


## Post-merge CI-only verification — 2026-10-24 (not live)

[PR #165](https://github.com/vyborovamaria3-maker/claude-project/pull/165) merged after [PR #184](https://github.com/vyborovamaria3-maker/claude-project/pull/184) was integrated. Exact merged main SHA: `0bfd1c71c438d2f32a93652f4b6a2670c38d7b9b`.

- At feature head `6d310e1322a404fd4b40a8427774f059f8976555`, all 12 observed PR-triggered workflows completed **SUCCESS**, including Intelligence foundation, Intelligence CI, Native social token-link CI, Shared contracts, TG collector checks and security, X collector quality/monitoring and hygiene. No live X account, TG session, Solana provider, production DB or model was accessed in those CI suites.
- After the main merge, [main Intelligence foundation](https://github.com/vyborovamaria3-maker/claude-project/actions/runs/40081855865), [native source evidence CI](https://github.com/vyborovamaria3-maker/claude-project/actions/runs/40081855822), [shared contracts](https://github.com/vyborovamaria3-maker/claude-project/actions/runs/40081855740) and [hygiene](https://github.com/vyborovamaria3-maker/claude-project/actions/runs/40081855688) had already passed at observation time. Other main workflows were still running when recorded; re-check exact SHA and workflow before claiming they passed.
- Isolated regression asserts X/TG source PostgreSQL + blockchain SQLite → distinct destination PostgreSQL, explicit preverified mint evidence, edit tombstone, source-local transaction rollback, injected destination COMMIT failure/no source ACK, duplicate replay, source-specific active projection and occurred/known-at boundaries. This is a **synthetic saved-proof test**, not fresh RPC verification; legacy generic `queryTokenTimeline` is deliberately empty for evidence-only events and the dedicated read-only evidence endpoint returns typed separated lists.
- **Live verification statuses remain NOT RUN BY THIS AUDIT.** Operator must first confirm production-safe backups+restores, independent migrations, explicit source flags/accounts/provider budget and sanitized logs. See [#173](https://github.com/vyborovamaria3-maker/claude-project/issues/173) and [#175](https://github.com/vyborovamaria3-maker/claude-project/issues/175).
