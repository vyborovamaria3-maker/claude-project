# CLAUDE-PROJECT — Codex integration handoff, 18 Oct 2026

## Status and explicit nonclaims

This is a **planning/rollout handoff**, not proof that a live integration has
been deployed. All new PRs are DRAFT; no user DB, Telegram session, X cookies
or Solana RPC accounts were touched by these changes.

Repository: vyborovamaria3-maker/claude-project

### Foundation PR stack (older main; sequential)

| PR | Head | Content |
|----|------|---------|
| #110 | feat/shared-contracts-foundation-20261018 | canonical IDs / evidence |
| #111 | feat/db-migration-contracts-20261018 | checksum PG/SQLite adapter |
| #112 | feat/shared-utilities-20261018 | retries, crypto, logs |
| #113 | feat/transactional-outbox-adapters-20261018 | leased PG/SQLite outbox |
| #114 | feat/intelligence-registry-20261018 | destination inbox/evidence |
| #115 | feat/intelligence-timeline-20261018 | point-in-time historical timeline |
| #116 | feat/intelligence-etl-delivery-20261018 | source ACK after target commit |
| #117 | feat/intelligence-token-features-20261018 | features-v1 snapshots |
| #118 | test/outbox-real-database-contracts-20261018 | actual temporary SQLite/PG |
| #119 | docs/codex-intelligence-handoff-20261018 | early handoff |
| #120 | fix/intelligence-provenance-collisions-20261018 | identity/evidence collision guards |
| #124 | feat/intelligence-local-etl-cli-20261018 | explicit local ETL, cross-DB tests |

Each base is the previous feature head. #124 is stacked on #120. **These
branches predate some changes already present in current main.** NEVER merge
the whole chain blindly; compare current main and PR feature file trees first.
Several historical migration prefixes in X Collector intentionally overlap.

### Source integrations (newer main; INDEPENDENT PRs)

| PR | Head | Source write integration / flag |
|----|------|----------------------------------|
| #121 | feat/tg-outbox-source-integration-20261018 | TG PG, `TG_INTELLIGENCE_OUTBOX_ENABLED=true` |
| #122 | feat/x-outbox-source-integration-20261018 | X PG, `X_INTELLIGENCE_OUTBOX_ENABLED=true` |
| #123 | feat/blockchain-sqlite-outbox-source-integration-20261018 | chain SQLite, `BLOCKCHAIN_INTELLIGENCE_OUTBOX_ENABLED=true` |

These 3 PRs are based on a newer `main`, independent of #110-#124. Source
producer flags are default OFF. Do NOT turn on before a working consumer is
available and the corresponding migrations are installed and verified.

## Important safety guarantees / identity scope

**X:** existing laptop worker, PostgreSQL and Playwright/XActions remain
unchanged when disabled. The 050 migration is registered in the explicit
`x-collector/lib/trade/migrations.ts` manifest. The producer inserts an
event inside the existing tweet/archive transaction, but only if numeric
`author_id` is available. Unknown authors must NOT be reconstructed from
mutable handles. Search mint context is not token ownership evidence.

**TG:** existing `tg-collector/sql/015_intelligence_outbox.sql` is consumed
by its native checksum migration runner. `tg_sources.peer_id` is the stable
Telegram channel identity; `tg_sources.id` is local database surrogate.
Message revision and soft-delete events are inserted in the same PG client
transaction. Missing peer_id fails closed in opt-in mode. Channel address
strings/tickers must NOT be promoted automatically to confirmed mints.

**Blockchain:** uses the existing on-laptop SQLite `trade.db` and existing
lease-fenced `processOne` outer transaction; raw wallet-target revisions
emit from nested `persistEvents` under opt-in. The event key contains
wallet, transaction signature and raw hash. **Wallet raw events are not
automatically trades, swaps, profit or authoritative PnL.** No token- or
creator-query candidate is promoted to a verified mint by this producer.

**Intelligence:** new isolated PG database with migrations in order:
`001_entity_registry.sql`, `002_timeline.sql`, `003_feature_store.sql`.
It deduplicates by source+kind+revision event key and records exact
source evidence. Timeline queries filter event occurrence and observation
cutoffs. Feature Store snapshots enforce as-of availability; feature
**producers/model training are not complete**.

## Local ETL command — non-background, explicit

Code: `intelligence/scripts/run.mjs` (PR #124). Run on the user's machine
with Node 22+ after installing shared packages and deploying destination.

1. `node scripts/run.mjs --help` prints safe options without opening DBs.
2. `node scripts/run.mjs --source tg --status` displays pending/dead-letter
   counts from an existing outbox (read-only). Other sources are `x` or
   `blockchain`.
3. To deliver a small bounded batch only AFTER backup, migrations, a
   disposable smoke test and explicit approval:
   `INTELLIGENCE_ETL_ENABLED=true node scripts/run.mjs --source tg --once --limit 25`
   (PowerShell: set the env variable for that command/session explicitly).

Environment for `--once`:
- `X_SOURCE_DATABASE_URL`: X Collector PostgreSQL DSN.
- `TG_SOURCE_DATABASE_URL`: TG Collector PostgreSQL DSN.
- `SOLANA_TRADE_DB_PATH`: absolute path to existing SQLite trade.db
  (do NOT assume local current working directory).
- `INTELLIGENCE_DATABASE_URL`: isolated Intelligence PostgreSQL DSN.

Only the DSN for selected source is needed. The CLI is a **single bounded
batch**, not a daemon, scheduler, deployment or traffic generator.

Read-only `--status` reports `pending`, `ready`, `leased`,
`retryDelayed`, `deadLetter`, `oldestPendingAt` and `maxAttempts`.
For SQLite it opens the source database read-only. These counters are not
a licence to manually reset locked leases or DLQ rows.

Verified CI status as of 18 October 2026: independent TG/X/Blockchain
producer PRs #121/#122/#123 and local ETL PR #124 pass all latest-head
checks, including temporary PostgreSQL/SQLite integration fixtures.
This is **not** evidence that a live producer/consumer was deployed. It
opens no browser, Telegram session or blockchain provider. No credentials
belong in repository, program logs, issue comments or PR descriptions.

## Required verification sequence in Codex

1. Read `AGENTS.md`, `docs/CODEX_PROJECT_CONTEXT.md`, current code, and
   all PR #110-#124 diffs and latest CI/check suites. Fetch current main ref.
2. Resolve conflicts and plan merges or selective cherry-picks. Run a
   changed-file collision report, especially TG and X manifests; avoid
   force-updating `main`. Keep incomplete PRs draft.
3. Run source tests independently on ephemeral DBs:
   - TG: `npm --prefix tg-collector run typecheck`, `npm --prefix tg-collector test`.
   - X: `npm --prefix x-collector run migrate:audit`,
     `npm --prefix x-collector run typecheck`, `npm --prefix x-collector test`.
   - Blockchain: `npm --prefix solana-launcher run blockchain:test`.
   - Shared: `packages/contracts`, `packages/db-common`,
     `packages/shared-utils`, `packages/event-outbox`, `intelligence`
     `npm run check` after installing their dependencies.
   - Run real PostgreSQL/SQLite cross-DB fixtures in PR #124.
4. Back up production PG and SQLite first. For SQLite use SQLite's online
   backup and WAL-aware quick_check/restore verification. DO NOT copy only
   trade.db while a writer may have a live WAL; no unreviewed migrations.
5. Apply existing source migration runners (TG 015, X 050 explicit manifest).
   Blockchain opt-in initializes its SQLite table ONLY after verified
   backup and local review. Apply isolated Intelligence target DDL.
6. Prove producer does not export secrets or fabricate token IDs. Prove
   unchanged message/tweet/raw observation replays are deduped while real
   revisions have distinct IDs. Verify source writes roll back with outbox.
7. Verify destination COMMIT-before-source-ACK, expired-leases, retry and
   dead-letter. Monitor pending oldest age, lag and DLQ. Exercise crash
   after destination commit and before source ACK.
8. Small dry-run/limited smoke only after all gates. Keep provider budgets,
   TG FloodWait, account locks, X rate limits and laptop resources bounded.
9. Only after source/target parity and backups are verified, implement a
   supervised **local** ETL schedule/worker and checkpointed historical backfill.

## Work still NOT implemented

- A verified deployed local consumer with continuous supervision; current
  CLI is explicit finite `--once` only.
- Production historical backfill (X missing stable author IDs; TG peer
  resolution; blockchain incomplete swap/token account history).
- Cross-source automatic verified token linking: address evidence cannot be
  inferred from a matched ticker or wallet label.
- Full Solana SPL Token-2022, Pump.fun/Raydium/Orca/Jupiter/Meteora decoder
  coverage and complete cost basis. **AUTHORITATIVE PnL must remain UNKNOWN**
  unless decoder + history + cost basis completeness are independently proven.
- Source-generated full FEATURES_V1 token vector with publishedAt availability
  dates; wallet/author/channel feature stores, embeddings and trained models.
- Out-of-sample, walk-forward backtests, realistic fees/slippage and
  calibrated uncertainty / false positive rates.
- Versioned `/api/v1` dashboard integration with admin authorization,
  interactive queue/metrics and safe proxy credential updates.
- Comprehensive production schema drift, monitoring/alert thresholds,
  retention and verified restore drills on actual owned databases.

Do not declare any of these as fully implemented just because their
contracts, tables or placeholders exist.

## Exact next Codex assignment

Start with the above three source PRs, reconcile their newer-main changes
with the stacked Intelligence PRs, run ALL applicable CI and actual temporary
source/destination fixtures. Build a local, bounded supervised ETL consumer
that runs from the user's laptop and can be stopped/drained. Exercise
restart/expired lease/partial failure before considering backfill. Preserve
all currently working functions; no live collection or account/login
mutation without explicit operator approval.
