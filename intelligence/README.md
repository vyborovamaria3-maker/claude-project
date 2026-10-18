# Intelligence — source evidence, entities and point-in-time timeline

Stacked PRs introduce an isolated PostgreSQL destination, not a replacement for
X/TG PostgreSQL or blockchain SQLite. Source databases are NOT modified here.

Migration order:
1. migrations/001_entity_registry.sql
2. migrations/002_timeline.sql

The caller uses ONE destination transaction:
- ingestRegistryEvent(tx, event) to insert inbox, entity registry, evidence.
- ingestTimelineEvent(tx, source, eventKind, timeline) to insert linked timeline.
- COMMIT destination; only THEN ACK source outbox event.

Both insertions use unique event identity to tolerate at-least-once replay.
The timeline query filters both event occurrence and source observation cutoff,
so a backfilled old tweet cannot appear in a past "known at" query.

Local (Node 22+):
  npm install --prefix packages/contracts --ignore-scripts --no-package-lock
  npm --prefix packages/contracts run build
  npm install --prefix intelligence --ignore-scripts --no-package-lock
  npm --prefix intelligence run check

CI uses a disposable PostgreSQL 16 database for real transaction, replay,
foreign-key and point-in-time tests. Does not connect to production databases.

Remaining: actually wiring source outboxes; migrations in production only after
reviewed backups; durable ETL with lease renewal and ACK; historical backfill
with reconciled cursors; authorization/read API; features and AI models.
