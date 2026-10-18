# Codex handoff — multi-source Intelligence rollout (2026-10-18)

## Status: additively implemented, NOT deployed

Repository: `vyborovamaria3-maker/claude-project`.

The work is a **stack of draft PRs**; `main` is not rewritten by this work.
Do not claim X/TG/Chain collectors are integrated merely because contracts,
the outbox library, Intelligence destination and isolated tests exist.

| Order | PR | Head | Actual implementation |
| --- | --- | --- | --- |
| 1 | #110 | feat/shared-contracts-foundation-20261018 | Stable identity, evidence/time contracts |
| 2 | #111 | feat/db-migration-contracts-20261018 | PG/SQLite checksum migration adapters |
| 3 | #112 | feat/shared-utilities-20261018 | Retry, local throttling, secret envelopes, redacted logging |
| 4 | #113 | feat/transactional-outbox-adapters-20261018 | PG and SQLite per-source outbox adapters |
| 5 | #114 | feat/intelligence-registry-20261018 | Destination inbox/entity registry/evidence |
| 6 | #115 | feat/intelligence-timeline-20261018 | Temporal schema, point-in-time queries |
| 7 | #116 | feat/intelligence-etl-delivery-20261018 | Bounded destination transaction/ACK batch |
| 8 | #117 | feat/intelligence-token-features-20261018 | Immutable features-v1 PostgreSQL snapshots |
| 9 | #118 | test/outbox-real-database-contracts-20261018 | Real temporary PG/SQLite source outbox tests |
| 10 | #119 | docs/codex-intelligence-handoff-20261018 | Codex rollout and event envelope specs |
| 11 | #120 | fix/intelligence-provenance-collisions-20261018 | Collision rejection and stricter chain evidence checks |

PR bases are stacked in order (PR #110 onto main, each next onto the
immediately preceding PR head). Verify current GitHub Actions checks and
branch ancestry before updating bases or merging. `main` is changing
independently: fetch latest refs and perform conflict review; avoid force-push.
**Do not merge Drafts or run live collection automatically.**

## Mandatory first checks in Codex

1. Read AGENTS.md, docs/CODEX_PROJECT_CONTEXT.md,
   docs/CODEX_PROGRESS.md and the *actual current* source files.
2. Inspect main, PR #65 (blockchain), PR #71 (TG), PR #98/#99/#100 (X).
   Verify which are merged; do not assume the state from 17 October.
3. Inspect PR #110-#118 CI for the latest commit, review diffs against
   current main, and confirm the desired merge/rebase strategy.
4. Run Node 22+ isolated regression checks:
   - npm --prefix packages/contracts run check
   - npm --prefix packages/db-common run check
   - npm --prefix packages/shared-utils run check
   - npm --prefix packages/event-outbox run check
   - npm --prefix intelligence run check
5. Do not apply any migration to a nonempty user database before an
   application-consistent backup, recovery test and reviewed DDL plan.

## Next critical engineering work — source integration

### X Collector: PostgreSQL, laptop only

- Preserve scripts/scheduler.ts, scripts/worker.ts, the existing queue,
  Playwright, XActions and transaction-fenced task writes.
- Its ordered applied migration manifest is
  x-collector/lib/trade/migrations.ts, **not** a sorted directory scan.
  Historical numeric prefixes are deliberately not unique. Never renumber
  previously applied SQL or replace the migration manifest in place.
- Add a **new** outbox migration after the confirmed latest migration and
  wire the source persistence transaction: tweet observation + outbox event
  share one existing PG client transaction.
- Different metric observations for one tweet must carry different eventKey
  values (e.g. tweet_id + observation timestamp/version), not only tweet_id.
- Session strings, cookies and proxies stay local; no mandatory remote
  collector service, no speculative cursor compatibility.

### Telegram Collector: feature PR #71 and PostgreSQL

- Start from the verified TG feature branch and preserve its actual
  migration ledger (feature branch previously contained sql/001..014).
- Use numeric Telegram source IDs; message identity is
  (source/channel ID, message ID), NOT just message_id.
- Add independent source outbox migration and write outbox in the SAME
  transaction as tg_messages/upsert. Distinguish message edits/deletes from
  original observations with revision keys. Soft-delete must preserve audit
  evidence. Keep GramJS session/proxy secrets server-side.
- Verify FloodWait retry, per-session advisory lock and restart checkpoint
  on fixtures before live limited TG smoke.

### Blockchain: existing SQLite until measured need to migrate

- Source remains solana-launcher/data/trade.db until a separately proven
  DB migration. Do not replace working CJS scripts or move live DB files
  without path reconciliation, checksums and rollback plan.
- Add a NEW SQLite outbox migration to the actual owner schema. Emit in the
  SAME better-sqlite3 transaction as authoritative event/trade write.
- Movement decoding is NOT automatically a trade. Separate AssetMovement
  from Swap/Trade; preserve raw units and provider+signature provenance.
- Alchemy-first, historical cursors, SPL Token-2022 and source provider
  coverage must be validated on real provider fixtures. `possible_gap`
  must remain explicit. Do not convert missing values to zero.
- No AUTHORITATIVE PnL without complete decoder, full wallet history
  and proven cost basis including transfers/fees. 21 fixture passes alone
  cannot prove full coverage.

### Destination ETL and replay

- Read packages/event-outbox/README.md and intelligence/README.md.
- Define explicit source adapters for existing source DB pools and the
  current SQLite connection; no new broker/server is required.
- The source emits a versioned event envelope with
  (sourceSystem,eventKind,eventKey,schemaVersion,payload).
- The payload for the foundation ETL must contain validated registryEvent,
  optionally timelineEvent. Identities MUST equal the outbox envelope.
- Claim small finite batches with leases; destination transaction begins;
  upsert source evidence/registry/timeline; COMMIT destination; only then ACK
  the SOURCE. ACK failure is redelivered; inbox must deduplicate.
- Add full integration tests with actual temporary X PG, TG PG, SQLite
  blockchain and destination Intelligence PG, plus crash-after-commit and
  expired-lease tests. Show per-source event counts and observed lag.
- Track event revisions; never coalesce a mutable tweet's entire metrics
  history into one eventKey. Add producer catch-up and historical backfill
  with explicit watermarks.

## Subsequent stages — not yet built

1. Blockchain modular extraction to blockchain-collector/ with behavioral
   parity, not direct bulk rewrite of Solana trade logic.
2. Backfill canonical token references into X tweet-token links and TG
   message links; exact Solana mint only, not ticker guesses.
3. Twitter-manipulation-analyzer extraction; preserve separate research
   SQLite and independent heuristics.
4. Feature producer for chain_token_features FEATURES_V1. Observe as-of
   cutoffs; keep missing values NULL and original raw evidence links.
5. Local embeddings/cluster classification; model versions and training
   labels (with outcome horizon, observed time, fees, slippage). Baselines,
   train/test temporal separation and out-of-sample quality required.
6. Dashboard/Admin API /api/v1 with per-mutation server-side authorization,
   existing-route compatibility, safe proxy secret handling.
7. Operations: real PG/SQLite backup, WAL-safe recovery verification,
   retention, queue metrics, DLQ review, health and alert testing.
8. Full CI: drift and contract tests against both engines, source-to-target
   delivery, migrations, unit/integration and release rollback checks.

## Acceptance gates

- Existing collector and app regression CI must remain passing.
- Each source maintains raw, normalized, derived provenance independently.
- Backfills are idempotent and do not falsely claim continuous history.
- ETL no lost committed source rows and no double-counted evidence after
  destination COMMIT / pre-ACK crash.
- Time-travel queries exclude data first observed after the query cutoff.
- Unknown block history, wallet owner, token balance, cost basis or PnL
  MUST NOT be replaced with fabricated authoritative values.
- No live data, secrets, sessions, proxy credentials or trade.db committed.
- No unrestricted bulk collection or API-key spending before explicit
  local smoke tests and resource budgets.

## Concrete first Codex assignment

Implement only the source-side outbox integration and exact cross-DB
end-to-end fixture in a new branch; preserve original X/TG/Blockchain
transactions and avoid opening the user's production SQLite database.
After CI is green, extend to read-only dry-run reconciliation. Keep
existing PR chain Draft until reviewed.
