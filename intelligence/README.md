# Intelligence — receiving events, timeline and feature snapshots

The Intelligence modules are built independently of collector databases.
Only the test workflow opens a disposable PostgreSQL 16 instance.

Migration order: 001_entity_registry.sql, 002_timeline.sql, 003_feature_store.sql.

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

Remaining: deployment-safe source migrations, explicit source writes and
backfill, real ETL process with source ports, blockchain reconciliation, AI
embeddings/training/outcome labels, secured APIs and operational runbooks.
