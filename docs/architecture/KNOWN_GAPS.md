# Architecture gaps and release gates — verified 2026-10-20

Repository baseline: main \`8dc7c2943ef08978f55009b15c86cd451517b654\`. Evidence: inspected code/SQL, PR metadata, GitHub Actions run/jobs/logs. **Do not mark live use as PASSED based on offline CI.** The checklist below is deliberately fail-closed.

Statuses: **IMPLEMENTED** = source code exists; **OFFLINE TESTED** = explicit isolated fixture/CI evidence; **NOT VERIFIED** = live deployment has not been demonstrated; **BLOCKED** = must be remedied before a dependent rollout.

| Priority | Area | Verified implementation / observation | Missing gate / action | Status |
| --- | --- | --- | --- | --- |
| P0 | Canonical IDs | \`packages/contracts/src/canonical-ids.ts\` validates full Solana/EVM addresses and stable social IDs | Confirm adapters of each production source use canonical validation | IMPLEMENTED; rollout NOT VERIFIED |
| P0 | Source outboxes | X migration 050, TG migration 015, Blockchain additive local SQLite; source flags opt-in | Backup/restore, inspect deployed migration ledgers, producer/consumer smoke and coverage counters | IMPLEMENTED; live NOT VERIFIED |
| P0 | Destination | Node \`intelligence/src\`: inbox, entity/evidence registry, timeline, feature schema in independent PG | Prove target schema applied safely on selected local DB and every source can ACK after commit | IMPLEMENTED; live NOT VERIFIED |
| P0 | Source identity | X base emitter refs only \`author\`; TG \`source\`; Blockchain \`wallet\` | Add conservative, revisioned **verified token-link** producer/resolver; preserve unknown/ambiguous | BLOCKED for token-level cross-source timeline |
| P0 | Continuous delivery | \`intelligence/scripts/run.mjs --source ... --once\` one bounded batch, no host supervisor | Drain/stop, lease renewal, lag/queue backpressure, restart, DLQ operator tooling | NOT IMPLEMENTED as continuous runtime |
| P0 | Event collision | Inbox rejects same key with mismatched schema/evidence source | Persist content fingerprint and reject different entity sets/payload with same event ID; additive migration and real PG failure tests | BLOCKED for mutable full materialization |
| P0 | Backup | Scheduled run 39219839895, 2026-10-19, failed in \`Create database backup\`: \`Host key verification failed\` | Verify authentic SSH host fingerprint through trusted channel, repair pinned known_hosts, rerun and restore-test | FAILED |
| P0 | Deploy | Run 39209623066, 2026-10-19: predeploy jobs success; \`Upload deployment configuration\` failed \`Host key verification failed\` | Repair SSH trust; never use \`StrictHostKeyChecking=no\` to silence | FAILED |
| P0 | Branch governance | API reports \`main\` \`protected:false\` | Add reviewed required checks / safeguards appropriate to repo; protect from accidental direct merge/force update | UNPROTECTED at audit time |
| P0 | ARCH-03 integration | Existing separate X/TG PG tests and SQLite tests; CI disposable Postgres, no account/provider calls | New \`cross-source-token-timeline.test.mjs\` validates 3 sources against one token with time boundaries/replay; observe latest-head CI result | TEST ADDED; CI RESULT PENDING |
| P1 | X identity coverage | No stable numeric \`authorId\` → source event skipped (not inferred from mutable handle) | Count exclusions, verified reconciliation/backfill of missing stable author IDs | NOT VERIFIED |
| P1 | TG identity coverage | Missing stable numeric \`peer_id\` fails closed when opt-in; source revision hashing | Peer resolution, skip/failure metrics, safe deletion/retraction on links, bounded backfill | NOT VERIFIED |
| P1 | Blockchain decoding | Raw wallet evidence and swap-only / partial decoder; \`token_trades\` remains legacy truth; PR #126 fixes some Pump routes but is OPEN | Token-account/transfer/burn/mint paths, finalized/reorg logic, complete cost-basis & denominator-based unknown-operation gate | Authoritative PnL BLOCKED |
| P1 | X autopost v2 | Reliability PR #127 OPEN, separate publisher; offline tests documented in PR | Target-head CI, review/merge, bounded live confirmation with operator; prevent ambiguous post-send retries | Live X action NOT VERIFIED |
| P1 | Historical materialization | Legacy X/TG/chain stores predate source outboxes | Checkpointed, dry-run-first backfill, preserved real observedAt/occurredAt, dedup and coverage | NOT IMPLEMENTED |
| P1 | API/UI | POTAPoff X/TG/Blockchain settings exist separately | Authenticated, versioned query API and unified token timeline/evidence UI | NOT IMPLEMENTED |
| P1 | Two Intelligence runtimes | Node cross-source delivery and Python document/provider scoring coexist under \`intelligence/\` | Write explicit runtime/DB naming contract, ensure build/deploy/CLI/import separation before any rename | COLLISION RISK; no forced migration |
| P1 | Monitoring | Existing source dashboards and 34 GitHub workflow files | Source-specific ETL lag, last progress, dead-letter, token coverage, backup age, canary alarms | INCOMPLETE |
| P2 | Signals/model | \`FEATURES_V1\` immutable as-of contracts; separate domain analytics exist | Source-backed feature producers, observed/published cutoffs, out-of-sample assessment, uncertainty | Model readiness NOT VERIFIED |

## Runbook: ARCH-01 and ARCH-03 acceptance

### Safe development checks

On a clean checkout with Node 22 and disposable PostgreSQL 16:

1. Install/check \`packages/contracts\`, \`packages/event-outbox\`, and \`intelligence\` using their own READMEs.
2. Supply **only a disposable** \`INTELLIGENCE_TEST_DB_URL\` (not the laptop's live source/target databases).
3. Run \`npm --prefix intelligence run check\`. The new cross-source test creates isolated schemas with random names and an in-memory SQLite source; it drops those temporary schemas on completion.
4. Confirm source pool isolation and three distinct events in \`intelligence_inbox\` and \`timeline_events\`, six entity-evidence links, and four canonical entities; confirm one query by the same canonical token returns X/TG/chain evidence.
5. Verify before-observation query excludes late TG evidence, early-occurred cutoff excludes later events, other mint returns no rows, and forced replays are counted as duplicates.
6. Verify process failure / lease expiry / DLQ tests in the existing suites and add full producer→resolver tests before claiming live token-link delivery.
7. Inspect target **latest SHA** GitHub Actions checks. Tests are not assumed passed until the actual run is green.

### Explicitly outside this pull request

- No modifications to existing source DBs, live config, outbox flags, wallet/trade attribution, X/TG sessions or RPC budgets.
- No live scraping, posting, subscriptions, token purchases or migrations.
- No claim that synthetic prelinked token fixtures prove source-side identity inference.
- No merge of draft PR #126/#127 or unreviewed historical migration stack.

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
- **ARCH-05:** evidence-verified, revisioned token-link contracts X/TG; align \`solana-mainnet\` to \`solana\` only after verification.
- **ARCH-06:** blockchain token/DEX evidence resolver with conservative decoder coverage.
- **ARCH-07:** end-to-end token link publication, retraction and timeline materialization; do not merge before real-source fixtures.
- **ARCH-08+:** checkpointed backfill, query API/UI, quality and alerting, followed by independently evaluated signals.

Related background: \`CODE_REVIEW_20261018.md\`, \`CODEX_FINAL_INTEGRATION_PLAN_20261018.md\`, and \`DATA_CONTRACTS.md\`. Keep status files accurate as work progresses.
