# Intelligence — inbox, entity registry, timeline and bounded delivery

Stacked isolated PostgreSQL destination; no production database is accessed.

Migrations in order:
1. migrations/001_entity_registry.sql
2. migrations/002_timeline.sql

The provider-neutral delivery adapter accepts an explicitly supplied source
and destination pool. runDeliveryBatch claims a bounded batch, checks that the
Outbox envelope matches source event identity, writes destination under BEGIN /
COMMIT and ACKs the source only AFTER successful commit. A failure rolls back
and schedules another attempt (bounded source retry/dead-letter policy).
A stale ACK lease is reported, never counted as a confirmed delivery.
Delivery remains at-least-once; destination inbox is idempotent.

Source adapters are implemented in packages/event-outbox for both PostgreSQL
and SQLite. This destination library does not open source sessions, connect
to live providers, configure remote workers or automatically install migrations.

Point-in-time timeline queries require event occurrence <= as-of AND source
observation <= known-at, protecting against late-arriving evidence leakage.

Local CI command (Node 22+):
  npm install --prefix packages/contracts --ignore-scripts --no-package-lock
  npm --prefix packages/contracts run build
  npm install --prefix packages/event-outbox --ignore-scripts --no-package-lock
  npm --prefix packages/event-outbox run build
  npm install --prefix intelligence --ignore-scripts --no-package-lock
  npm --prefix intelligence run check

GitHub CI includes a disposable PostgreSQL 16 service. Production source
writes, outbox migrations and a supervised ETL process are NOT connected by
these PRs. A source event must be created in the same transaction as its
actual source row, and checkpoint backfill requires a separate rollout.
