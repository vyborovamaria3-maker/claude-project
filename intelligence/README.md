# Intelligence — receiving events, timeline and feature snapshots

The Intelligence modules are built independently of collector databases.
Only the test workflow opens a disposable PostgreSQL 16 instance.

Migration order: 001_entity_registry.sql, 002_timeline.sql, optional 003_feature_store.sql, mandatory 004_token_link_observations.sql before source delivery. Do not start the ETL supervisor against a target missing 004.

- Ingest RegistryEvent after claiming a source outbox event; source ACK only after
  destination transaction commits. Consumer runDeliveryBatch remains a bounded,
  explicit library call. It is NOT connected to running collectors.
- Timeline queries filter both event occurrence and time first observed, so a
  late-arriving historical tweet cannot leak into an earlier known-at view.
- The feature registry has immutable version definitions. FEATURES_V1 contains
  user-specified token-level metrics. Missing sentiment or bot-ratio values are
  represented as null rather than silently as zero.
- Feature snapshots record as_of and max_input_observed_at. Later-observed
  inputs are rejected. Duplicate identical snapshots are accepted as no-op;
  conflicting revisions require a NEW explicit feature version or new as_of.
- A historical offline recomputation at an earlier as_of is NOT a proof that a
  trading signal was actually available at that moment. A future production
  backtest must separately use feature publication times and observed labels.

CI builds the shared contract, event-outbox and Intelligence modules and tests
PostgreSQL transaction/replay, timeline cutoffs and feature schema invariants.
No X or Telegram account, blockchain provider, local production DB or session
is accessed by these tests.

Local commands (Node 22+):
  npm install --prefix packages/contracts --ignore-scripts --no-package-lock
  npm --prefix packages/contracts run check
  npm install --prefix packages/event-outbox --ignore-scripts --no-package-lock
  npm --prefix packages/event-outbox run check
  npm install --prefix intelligence --ignore-scripts --no-package-lock
  npm --prefix intelligence run check

Remaining: deployment-safe source migrations and opt-in real data verification,
backfill, blockchain reconciliation, verified token-link producers,
AI embeddings/training/outcome labels, secured APIs and operational runbooks.

## Bounded local ETL CLI (explicit opt-in)

There is no cloud collector or implicit background service. After reviewing and
installing the destination migrations in an isolated PostgreSQL database, and
source migrations for each local collector, an operator can run:

    npm run build
    node scripts/run.mjs --source tg --status
    INTELLIGENCE_ETL_ENABLED=true node scripts/run.mjs --source tg --once --limit 25

Other sources: `--source x`, `--source blockchain`. Environment variables:
`X_SOURCE_DATABASE_URL`, `TG_SOURCE_DATABASE_URL`,
`SOLANA_TRADE_DB_PATH`, and `INTELLIGENCE_DATABASE_URL`.

The status command only reads source outbox counts. The once command is
explicitly gated and handles one finite claim batch with destination transaction
commit before source ACK; no Telegram login, browser, provider request, replay
loop, background scheduling, or trading instruction is performed. Keep all
credentials in locally secured environment settings (never commit them).
For SQLite, use the absolute path to a verified local DB; do not open a live
`trade.db` until WAL-safe backup and restore rehearsal. Follow the staged
Codex handoff for source and consumer rollout.

Temporary PostgreSQL 16 + memory-only SQLite cross-DB tests prove synthetic
event integrity and replay. They do NOT prove sustained throughput, recovery
under provider outages, completeness of blockchain history, or live collection.


## ARCH-04 — foreground local ETL Supervisor (explicit opt-in)

`scripts/supervise.mjs` handles independent X, Telegram and Blockchain source
outboxes in the **foreground on the laptop**. It does not run a server, browser,
XActions, MTProto, Solana RPC, trades, publishers or migration command. The
existing `run.mjs --status` and `run.mjs --once` modes remain available.

**Prerequisites:** verified independent source outbox schemas, destination
Intelligence PostgreSQL migrations 001 and 002, WAL-safe backup/restore drill,
dedicated DB privileges, and a reviewed local configuration. Producers remain
disabled by default; do not turn them on merely because a consumer exists.

Windows PowerShell, from `intelligence` (never commit these variables):

```powershell
$env:INTELLIGENCE_ETL_ENABLED = 'true'
$env:INTELLIGENCE_SUPERVISOR_ENABLED = 'true'
# Use separately scoped connection strings and your verified local paths:
# $env:X_SOURCE_DATABASE_URL = '<X PostgreSQL DSN>'
# $env:TG_SOURCE_DATABASE_URL = '<Telegram PostgreSQL DSN>'
# $env:SOLANA_TRADE_DB_PATH = '<absolute path to trade.db>'
# $env:INTELLIGENCE_DATABASE_URL = '<separate Intelligence PostgreSQL DSN>'
node scripts/supervise.mjs --sources x,tg,blockchain
```

For a safe bounded isolated test, use
`node scripts/supervise.mjs --sources blockchain --max-batches 1`
with a **temporary copy** of SQLite and a disposable destination PostgreSQL.

Options: `--sources x,tg,blockchain` (any nonempty distinct subset),
`--poll-ms 2000`, `--pace-ms 100`, `--lease-ms 120000`,
`--max-failures 5`, `--max-batches 0` (zero means until Ctrl+C).

Runtime safeguards:

- One claimed event per source batch, bounded sequential processing per source.
- Independent asynchronous loops for the selected sources; no cross-source
  transaction or broker. Every loop has its own source connection/worker ID.
- Source lease renewal during a slow destination operation. Every renewal
  returns an exact updated fencing token; ACK/NACK uses the most recent token.
  Failed renewals block ACK and allow safe idempotent replay.
- Destination writes use a finite query/statement timeout. A connection error
  triggers a bounded retry delay; repeated failures stop the supervisor rather
  than silently retrying without bound.
- Ctrl+C/SIGTERM stops **new** claims and lets current destination operations
  finish before closing connection pools.
- Bounded JSON lines include counters and error **codes**, never event payloads,
  passwords or original exception strings.
- Operator can inspect per-source backlog and dead letters using the existing
  read-only `run.mjs --source <source> --status`.

Caveats: this implementation does not persist a machine-level process manager,
does not create a health HTTP service, does not apply migrations, and does not
validate a live X/TG/Blockchain producer or the real token-link resolver.
Startup after Windows restart requires explicit process launch. The current
one-shot CLI can claim more than one event, so its unstarted batch members are
not heartbeat-protected; keep its batch size small on slow destinations.

Cross-source timeline identity remains blocked by the missing evidence-based
token-link producer; the synthetic token-linked ARCH-03 integration test
does not establish real token recognition.
