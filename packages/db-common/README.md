# Database migration compatibility package (PR-2)

Provides additive, checksum-validated migration runners for **existing caller-owned**
PostgreSQL pools and **existing caller-owned** better-sqlite3 databases.

- PostgreSQL: one connection, BEGIN, advisory transaction lock, per-migration SQL,
  manifest/checksum validation and atomic COMMIT/ROLLBACK.
- SQLite: BEGIN IMMEDIATE, manifest/checksum validation, atomic COMMIT/ROLLBACK.
- Replays are idempotent. Changed, deleted or out-of-order migrations fail closed.
- The caller supplies explicit ordered SQL files, with unique new filenames.
- No global pool, no DB opened here, no remote server, no live migrations.

**Do NOT apply to X Collector's existing migrations** unless its historical
manifest and earlier schema tracking have been reconciled. Existing X migration
files have repeated numeric prefixes and use an explicit historical manifest;
this package's filename uniqueness rule MUST NOT replace that manifest.

Run: `npm install --prefix packages/db-common --ignore-scripts --no-package-lock`
then `npm --prefix packages/db-common run check`.

Integration with production databases and DDL-specific schema-drift tests are
future stages and are not claimed by these isolated adapter tests.
