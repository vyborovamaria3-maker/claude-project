# Architecture gaps and release gates — baseline 2026-10-20; status delta 2026-10-24

Repository baseline: main `8dc7c2943ef08978f55009b15c86cd451517b654`. Evidence: inspected code/SQL, PR metadata, GitHub Actions run/jobs/logs. **Do not mark live use as PASSED based on offline CI.** The checklist below is deliberately fail-closed.

## Current status pointer — 2026-10-30

The matrix below preserves the 2026-10-20 baseline and 2026-10-24 historical delta. It is not a current status snapshot. Use [TECHNICAL_DEBT_REGISTER_20261030.md](TECHNICAL_DEBT_REGISTER_20261030.md) for the current P0/P1 register and [REPOSITORY_BASELINE_20261030.md](REPOSITORY_BASELINE_20261030.md) for the current architecture inventory.

Important corrections since the historical matrix:
- GitHub currently reports `main.protected=false`; [issue #170](https://github.com/vyborovamaria3-maker/claude-project/issues/170) remains admin-blocked.
- A foreground, opt-in Node Intelligence supervisor exists (`intelligence/scripts/supervise.mjs`); this does not mean it is running or monitored in production.
- Blockchain has opt-in provider-parsed swap evidence and revision events, offline receipt validation and a two-witness signed-report acceptance store; these do not establish authenticated RPC service provenance or Solana consensus finality.
- PR #203's latest CI is green on its current head, but it remains open and live X/TG/RPC, backup/restore and production data status remain separate gates.

Statuses: **IMPLEMENTED** = source code exists; **OFFLINE TESTED** = explicit isolated fixture/CI evidence; **NOT VERIFIED** = live deployment has not been demonstrated; **BLOCKED** = must be remedied before a dependent rollout.

| Priority | Area | Verified implementation / observation | Missing gate / action | Status |
| --- | --- | --- | --- | --- |
| P0 | Canonical IDs | `packages/contracts/src/canonical-ids.ts` validates full Solana/EVM addresses and stable social IDs | Confirm adapters of each production source use canonical validation | IMPLEMENTED; rollout NOT VERIFIED |
| P0 | Source outboxes | X migration 050, TG migration 015, Blockchain additive local SQLite; source flags opt-in | Backup/restore, inspect deployed migration ledgers, producer/consumer smoke and coverage counters | IMPLEMENTED; live NOT VERIFIED |
| P0 | Destination | Node `intelligence/src`: inbox, entity/evidence registry, timeline, feature schema in independent PG | Prove target schema applied safely on selected local DB and every source can ACK after commit | IMPLEMENTED; live NOT VERIFIED |
| P0 | Source identity | X base emitter refs only `author`; TG `source`; Blockchain `wallet` | Add conservative, revisioned **verified token-link** producer/resolver; preserve unknown/ambiguous | BLOCKED for token-level cross-source timeline |
| P0 | Continuous delivery | `intelligence/scripts/run.mjs --source ... --once` one bounded batch, no host supervisor | Drain/stop, lease renewal, lag/queue backpressure, restart, DLQ operator tooling | NOT IMPLEMENTED as continuous runtime |
| P0 | Event collision | Inbox rejects same key with mismatched schema/evidence source | Persist content fingerprint and reject different entity sets/payload with same event ID; additive migration and real PG failure tests | BLOCKED for mutable full materialization |
| P0 | Backup | Scheduled run 39219839895, 2026-10-19, failed in `Create database backup`: `Host key verification failed` | Verify authentic SSH host fingerprint through trusted channel, repair pinned known_hosts, rerun and restore-test | FAILED |
| P0 | Deploy | Run 39209623066, 2026-10-19: predeploy jobs success; `Upload deployment configuration` failed `Host key verification failed` | Repair SSH trust; never use `StrictHostKeyChecking=no` to silence | FAILED |
| P0 | Branch governance | API reports `main` `protected:false` | Add reviewed required checks / safeguards appropriate to repo; protect from accidental direct merge/force update | UNPROTECTED at audit time |
| P0 | ARCH-03 integration | Existing separate X/TG PG tests and SQLite tests; CI disposable Postgres, no account/provider calls | New `cross-source-token-timeline.test.mjs` validates 3 sources against one token with time boundaries/replay; observe latest-head CI result | TEST ADDED; CI RESULT PENDING |
| P1 | X identity coverage | No stable numeric `authorId` → source event skipped (not inferred from mutable handle) | Count exclusions, verified reconciliation/backfill of missing stable author IDs | NOT VERIFIED |
| P1 | TG identity coverage | Missing stable numeric `peer_id` fails closed when opt-in; source revision hashing | Peer resolution, skip/failure metrics, safe deletion/retraction on links, bounded backfill | NOT VERIFIED |
| P1 | Blockchain decoding | Raw wallet evidence and swap-only / partial decoder; `token_trades` remains legacy truth; PR #126 changes were integrated by main carrier PR #133 on 2026-10-20; later related fixes continue | Token-account/transfer/burn/mint paths, finalized/reorg logic, complete cost-basis & denominator-based unknown-operation gate | Authoritative PnL BLOCKED |
| P1 | X autopost v2 | Reliability PR #127 merged to integration carrier #133 and main on 2026-10-20; offline tests documented in PR | Bounded operator-approved live X post/action verification and post-send uncertainty/manual reconciliation evidence; no automated resends of ambiguous sends | MERGED; live X action NOT VERIFIED |
| P1 | Historical materialization | Legacy X/TG/chain stores predate source outboxes | Checkpointed, dry-run-first backfill, preserved real observedAt/occurredAt, dedup and coverage | NOT IMPLEMENTED |
| P1 | API/UI | POTAPoff X/TG/Blockchain settings exist separately | Authenticated, versioned query API and unified token timeline/evidence UI | NOT IMPLEMENTED |
| P1 | Two Intelligence runtimes | Node cross-source delivery and Python document/provider scoring coexist under `intelligence/` | Write explicit runtime/DB naming contract, ensure build/deploy/CLI/import separation before any rename | COLLISION RISK; no forced migration |
| P1 | Monitoring | Existing source dashboards and 34 GitHub workflow files | Source-specific ETL lag, last progress, dead-letter, token coverage, backup age, canary alarms | INCOMPLETE |
| P2 | Signals/model | `FEATURES_V1` immutable as-of contracts; separate domain analytics exist | Source-backed feature producers, observed/published cutoffs, out-of-sample assessment, uncertainty | Model readiness NOT VERIFIED |

## Runbook: ARCH-01 and ARCH-03 acceptance

### Safe development checks

On a clean checkout with Node 22 and disposable PostgreSQL 16:

1. Install/check `packages/contracts`, `packages/event-outbox`, and `intelligence` using their own READMEs.
2. Supply **only a disposable** `INTELLIGENCE_TEST_DB_URL` (not the laptop's live source/target databases).
3. Run `npm --prefix intelligence run check`. The new cross-source test creates isolated schemas with random names and an in-memory SQLite source; it drops those temporary schemas on completion.
4. Confirm source pool isolation and three distinct events in `intelligence_inbox` and `timeline_events`, six entity-evidence links, and four canonical entities; confirm one query by the same canonical token returns X/TG/chain evidence.
5. Verify before-observation query excludes late TG evidence, early-occurred cutoff excludes later events, other mint returns no rows, and forced replays are counted as duplicates.
6. Verify process failure / lease expiry / DLQ tests in the existing suites and add full producer→resolver tests before claiming live token-link delivery.
7. Inspect target **latest SHA** GitHub Actions checks. Tests are not assumed passed until the actual run is green.

### Explicitly outside this pull request

- No modifications to existing source DBs, live config, outbox flags, wallet/trade attribution, X/TG sessions or RPC budgets.
- No live scraping, posting, subscriptions, token purchases or migrations.
- No claim that synthetic prelinked token fixtures prove source-side identity inference.
- This older 2026-10-20 section preceded the PR #133 integration: #126/#127 were subsequently included in main via #133. **No further live rollout, production migration or external action is authorized by this document.**

## Deployment requirements before any live producer opt-in

1. Verify local laptop data ownership and source/target connection identities.
2. Perform and restore-test isolated PostgreSQL backups and WAL-aware SQLite online backup; verify integrity and historical source rows.
3. Audit native X migration manifest and TG runner, and destination Intelligence migration order.
4. Prove a supervised bounded local consumer can stop and recover, with source ACK only after committed target.
5. Prove publisher/session/keys do not enter outbox and invalid/ambiguous token refs fail closed.
6. Start with tiny explicit operator-approved batches; monitor oldest pending age, failed, lost lease, DLQ, and cross-source parity before widening.
7. Retain a rollback strategy that disables opt-in flags without rewriting existing source data.

## Next PR order

- **ARCH-02:** fix/pin SSH host trust for deploy and backup, restore drill, branch governance (requires repository admin/operator access).
- **ARCH-04:** bounded laptop-local ETL supervisor; graceful shutdown, lease renewal, restart and backpressure, integration fault injection.
- **ARCH-05:** evidence-verified, revisioned token-link contracts X/TG; align `solana-mainnet` to `solana` only after verification.
- **ARCH-06:** blockchain token/DEX evidence resolver with conservative decoder coverage.
- **ARCH-07:** end-to-end token link publication, retraction and timeline materialization; do not merge before real-source fixtures.
- **ARCH-08+:** checkpointed backfill, query API/UI, quality and alerting, followed by independently evaluated signals.

Related background: `CODE_REVIEW_20261018.md`, `CODEX_FINAL_INTEGRATION_PLAN_20261018.md`, and `DATA_CONTRACTS.md`. Keep status files accurate as work progresses.


## TG Collector analytics sprint-0 delta — code audit 2026-10-22

This section supplements, not replaces, the cross-source deployment blockers above. `EXISTS` means a concrete implementation or migration was inspected. No database state, local service or real Telegram session was available to this audit.

| Priority | TG analytics unit | Code evidence and **confirmed** state | Gap / minimum acceptance test | Audit status |
| --- | --- | --- | --- | --- |
| P0 | Schema evolution | `src/db.ts` creates `schema_migrations(name,checksum,applied_at,applied_by)`, validates stored checksum before applying further numbered migrations; SQL files 001–035 exist. | Disposable clean and upgraded-DB migration replay, schema introspection and checksum tamper negative case. | EXISTS; replay NOT EXECUTED |
| P0 | Token cross-source join | TG native `tg_tokens(chain_id,mint)`, `chain_id='solana-mainnet'`; shared contract uses canonical `solana:<mint>`. Source outbox is default-off. | Contract test with exactly same mint in TG, X, Blockchain; verified-mint-only versioned adapter and source retraction. | BLOCKED for live token join |
| P0 | Token candidates vs token | `tg_token_candidates`, `tg_ticker_registry`, `tg_token_mentions` and on-chain mint layout resolver already exist. | Test ambiguous ticker, wrong SPL layout, stale attestation, revision retraction and high-volume sample with actual RPC permissions. | EXISTS; live coverage NOT VERIFIED |
| P0 | History claims | Full-history pass and coverage migration sequence 023, 029, 031, 033 exists; `tg_token_first_mentions.coverage_status` exists. | Implement safe `validate:coverage` CLI only after auditing checkpoint semantics; show `partial/gap/unknown`, never fabricate expected count from sparse Telegram IDs. | PARTLY IMPLEMENTED; CLI NOT VERIFIED |
| P0 | Market outcomes | `market-data.ts` uses DexScreener observed snapshots, tolerance windows and `outcome_status='insufficient_data'` when base price absent; run from explicit scripts. | `result_reason` taxonomy for distinct unknown reasons; stale/missing snapshots and no-peeking fixtures; test actual snapshot history coverage. | EXISTS; outcomes NOT LIVE VERIFIED |
| P0 | Historical backtest | `backtest.ts` requires chronological `from < test-start < to` and completed 24h outcomes; stores baseline and per-signal results. | Review event-time vs observation-time leakage, selection bias, overlapping token samples, uncertainty/CI, provider history and holdout quality. | EXISTS; predictive validity NOT VERIFIED |
| P1 | Channel score | `refreshChannelScores` calculates component scores and composite only when at least 5 outcomes and all component inputs available. | Add operator-visible missing-input reasons without fabricating score; sample-size/robustness and real-outcome checks. | EXISTS; score_reason NOT VERIFIED |
| P1 | Velocity and scheduling | `refreshTokenVelocity` has windows 5m/15m/1h/6h/24h and independent copy clusters; SQL projects `NULL` for `z_score`. Worker loop only runs discovery and collection; analytics refresh is an explicit CLI. | Define safe bounded scheduler/refresh cadence, deterministic baseline `z_score`, query cost/time and restart recovery. | PARTIAL: no worker scheduler; `z_score` unavailable |
| P1 | Duplicate/copy signals | `tg_message_fingerprints`, `tg_copy_clusters`, `tg_message_similarity` exist; extractor does normalized exact matching, plus candidate similarity path. | Demonstrate 100 copies counted as 100 posts but 1 independent cluster; inspect false positives and lifecycle retractions. | EXISTS; measured accuracy NOT VERIFIED |
| P1 | Coordination/risk/bots | `tg_coordination_events`, `tg_author_bot_scores` exist; model-facing infrastructure present. | Calibrate against labeled evidence; do not equate synchronicity with conspiracy or bot-score with human identity. | EXISTS; accuracy NOT VERIFIED |
| P1 | Natural-language narratives | `src/analytics/narratives.ts` uses `NARRATIVE_MODEL_VERSION='keyword-v1'`; narratives are attached to verified token observations. | Add benchmark with labeled multi-language Telegram content before claiming embedding/semantic detection. | KEYWORD IMPLEMENTED; embedding NOT VERIFIED |
| P1 | TG dashboards | Next.js integration routes, source/graph API, admin controls exist. | Auth/CSRF/access smoke with local dev instance and query verification against test TG DB. | EXISTS; live UI NOT VERIFIED |
| P1 | Operational health | Worker has advisory lock, heartbeat, FloodWait, queue lease handling; `db:metrics` is an explicit entrypoint. | Measure heartbeat freshness, delayed queue, analytics staleness and backup/restore; alert channels to be specified. | EXISTS; observability end-to-end NOT VERIFIED |

### Recommended bounded next actions

1. **Do not add** duplicate `tg_token_mentions`, `tg_ticker_registry`, `tg_message_fingerprints`, `tg_author_bot_scores`, `tg_token_velocity`, `tg_channel_scores`, `tg_token_outcomes` or `schema_migrations`. They exist in checked migrations.
2. First obtain *read-only and non-secret* aggregate DB observations from a safe TG test fixture, then distinguish absent data from code failure. Never connect audit commands to the laptop production DB by default.
3. Write tests for common token ID mapping, contradictory ticker claims, chronological first mention, empty/missing prices and duplicate-text independent cluster counts before optimizing code.
4. Only after isolated green tests, schedule offline refresh and market outcome tasks with explicit RPC rate/budget limits and stop/backpressure semantics. Retention and other destructive jobs remain opt-in.
5. Archive live results, environment, commit SHA and evidence links in [LIVE_TESTS.md](LIVE_TESTS.md); keep `NOT RUN` until tests genuinely execute.

See [TG contracts](DATA_CONTRACTS.md). No production read, migration, mutation, live Telegram call, paid Solana RPC or secret inspection was performed for this delta.


## Status delta — 2026-10-24 (non-live GitHub audit)

**Baseline caveat:** the top P0/P1 table was originally verified against `8dc7c294...` on 2026-10-20. Historical backup/deploy failures are evidence of **those 2026-10-19 runs**, not a fresh verdict on current remote infrastructure. Current `main` was observed at `8f79ce9284e42e35de78e0e983c6ba460677ef58`; the linked [delivery plan](DELIVERY_PLAN_20261024.md) is the active remediation backlog. No user laptop, deployed DB or live provider was accessed as part of this delta.

| Priority | Finding (24 Oct) | Evidence | Follow-up/status |
| --- | --- | --- | --- |
| P0 | Main branch `protected=false` at check time | GitHub branch API on head `8f79ce92` | [#170](https://github.com/vyborovamaria3-maker/claude-project/issues/170); **ADMIN ACTION REQUIRED**. No rules were changed. |
| P0 | PR #167 head `f24e0e2d`: security production audits fail for legacy-miniapp and subscription-service; other reported security jobs pass | [Security Gates run](https://github.com/vyborovamaria3-maker/claude-project/actions/runs/40071746530) | [#171](https://github.com/vyborovamaria3-maker/claude-project/issues/171); **PR BRANCH FAIL**, do not transpose to main. |
| P0 | Source-to-Intelligence live token join + opt-in delivery remains unproven | [DATA_CONTRACTS](DATA_CONTRACTS.md), [LIVE_TESTS](LIVE_TESTS.md) | [#173](https://github.com/vyborovamaria3-maker/claude-project/issues/173), [#174](https://github.com/vyborovamaria3-maker/claude-project/issues/174), [#175](https://github.com/vyborovamaria3-maker/claude-project/issues/175); **NOT LIVE VERIFIED**. |
| P0 | Physical DB count and deployed backup/restore state not independently verified today | Code ownership map only, historic SSH trust failures | [#172](https://github.com/vyborovamaria3-maker/claude-project/issues/172); **NEEDS INVENTORY/DRILL**; do not assert “9 DBs”. |
| P1 | PRs #165 (canonical IDs), #166 (AI read model stacked onto #165) and #167 (AI analytics/gateway to main) remain open | [PR_STATUS](PR_STATUS.md) | [#176](https://github.com/vyborovamaria3-maker/claude-project/issues/176); **DESIGN/BASE REVIEW REQUIRED** before merge. |
| P1 | PR #127 is **merged**, and #142 was merged into an integration branch that reached main through carrier #133. Their original PR body contains earlier “not merged” statements. | [#127](https://github.com/vyborovamaria3-maker/claude-project/pull/127), [#133](https://github.com/vyborovamaria3-maker/claude-project/pull/133), [#142](https://github.com/vyborovamaria3-maker/claude-project/pull/142) | Offline/code integration acknowledged; **no claim of live autoposting, real production sentiment or complete historical coverage**. |
| P1 | README previously described mainly a subscription deploy candidate | Root README before documentation change | Root README revised on audit branch; **not a production-readiness proof**. |

**Guidance:** historical sections above preserve original review evidence and may refer to PRs as “open” at the time of writing. Treat this delta and actual GitHub PR pages as current state. Never change a live status from `NOT RUN` to `PASSED` without the evidence schema in [LIVE_TESTS](LIVE_TESTS.md).


## P0-04 verified evidence delta — 2026-10-24 after merge #165

- **IMPLEMENTED / OFFLINE-TESTED:** [#165](https://github.com/vyborovamaria3-maker/claude-project/pull/165) merged to main as `0bfd1c71c438d2f32a93652f4b6a2670c38d7b9b` with native canonical mint adapters, verified social link/retraction code, strict JSONB validation, isolated PostgreSQL/SQLite delivery tests and authenticated read-only `/tokens/:id/evidence`. Stacked [#184](https://github.com/vyborovamaria3-maker/claude-project/pull/184) was integrated into #165 before its main merge; all relevant PR head CI workflows passed. Do not continue to label #165 “OPEN” in current status summaries; older tables above are historical snapshots.
- **EXISTING CODE, NOT YET OPERATED LIVE:** X's [bounded Alchemy mint CLI](X_MINT_VERIFICATION.md) and TG's verified-mint resolver are opt-in and default off. An earlier statement that **no X mint verifier exists** is inaccurate; what remains unverified is real operator-controlled execution and delivery to Intelligence from production-grade, backed-up stores.
- **NOT VERIFIED / BLOCKED ON OPERATOR:** live X/TG/chain provider observation, source migrations in actual operating environments, production-safe backup **and restore**, supervised recovery, complete source coverage and authenticated application UX. Continue [#173](https://github.com/vyborovamaria3-maker/claude-project/issues/173) as OPEN. Do not equate passing synthetic/isolated CI with live completeness or validated financial signals.
- **DESIGN/SECURITY REVIEW STILL REQUIRED:** [#166](https://github.com/vyborovamaria3-maker/claude-project/pull/166) is still a stacked draft AI read model; [#167](https://github.com/vyborovamaria3-maker/claude-project/pull/167) overlaps read/AI analytics. Its 2026-10-24 Security Gates failure relates to that PR head; no blanket claim about current main. Reconcile through [#176](https://github.com/vyborovamaria3-maker/claude-project/issues/176), and verify all checks at the actual integration head.
- **GOVERNANCE STILL BLOCKED:** `main` was observed `protected=false` even after #165 merge, requiring repository-admin action under [#170](https://github.com/vyborovamaria3-maker/claude-project/issues/170).
