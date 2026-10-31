# End-to-end evidence and backup/restore rehearsal — 2026-10-31

## Scope and safety boundary

This change adds deterministic, non-production integration coverage and closes a
backup omission found in the deployed Admin Compose definition. It does not
connect to production databases, Telegram/X accounts, Helius/Alchemy endpoints,
wallets, SSH hosts or deployment infrastructure. All provider responses and
source records in the new integration test are fixtures.

A green CI result is evidence for the tested code path and fixture only. It is
not evidence that production credentials, source permissions, retention,
off-site copies, live collection or a deployment are correct.

## Producer → consumer integration

Workflow: .github/workflows/source-producer-to-consumer.yml

Test: intelligence/tests/source-producer-to-consumer.test.mjs

The test uses an isolated PostgreSQL service, a separate PostgreSQL schema for
each source and an in-memory SQLite database for Blockchain. It invokes:

1. **X:** the actual bounded verifyXTokenLinksOnce candidate-verification
   control flow, the actual verifySolanaMintViaAlchemy parser with a mocked
   HTTPS getAccountInfo response, and the actual transactional
   emitXVerifiedTokenLinkOutbox writer.
2. **Telegram:** the actual readMintAccount parsed-account verifier with a
   mocked HTTPS response and the actual transactional
   emitVerifiedTgTokenLinkOutbox writer.
3. **Blockchain:** the actual emitTokenSwapRevisionOutbox writer with a
   deterministic parsed wallet-swap fixture in an in-memory SQLite source.
4. **Intelligence:** the real destination migrations and runDeliveryBatch
   consumer, writing to a separate disposable PostgreSQL schema.

Assertions cover the two independently verified social token links, one
supported parsed swap-evidence revision, source-text exclusion from social
outbox payloads, source edit tombstones, and the fact that social invalidation
does not erase independent Blockchain evidence. The test then simulates lost
source ACKs and confirms idempotent replay of all five source events.

Important semantic limits:

- The test does not start X browser collection, a Telegram MTProto session,
  background collectors, the foreground supervisor, AI analysis or a live RPC.
- The RPC bodies are local fixtures. No external provider is called.
- The Blockchain event is parsed swap evidence; it is not SPL Mint proof,
  finalized transaction status, realized PnL or proof that a trade settled.
- Token-link observations and parsed swap revisions do not automatically
  create a generic timeline event. The test explicitly asserts that no
  unsupported timeline row is fabricated.
- This is a bounded producer/consumer batch integration, not a sustained-load,
  outage-duration, production scheduling or live source-completeness test.

## Database inventory and recovery coverage

| Store | Current owner / location | Backup path | Automated non-production restore evidence |
| --- | --- | --- | --- |
| POTAPoff product PostgreSQL | potapoff Compose PostgreSQL | solana-launcher/scripts/backup-production.sh → postgres.dump | verify-backup-restore.sh; ARCH-02 synthetic Docker rehearsal |
| Admin Control Center PostgreSQL | potapoff-admin-postgres | Same script → admin-postgres.dump | Same isolated PostgreSQL restore rehearsal |
| Python Intelligence SQLite | potapoff-intelligence, named intelligence-state volume, /var/lib/potapoff-intelligence/intelligence.sqlite3 | Same script → intelligence.sqlite, created with Python SQLite online backup API | Isolated Python container restores a copy, runs PRAGMA integrity_check, checks table presence and the CI rehearsal checks a fixture row |
| X Collector PostgreSQL | Local X Collector database | x-collector/scripts/backup-windows.ps1, custom-format archive | x-collector-ci.yml now runs a disposable custom-format dump/restore and truncated-archive rejection |
| Telegram Collector PostgreSQL | Local TG Collector database | tg-collector/scripts/backup.sh, custom-format archive and SHA256; optional rclone remote | tg-collector.yml already runs a disposable full restore, row-count comparison and non-empty-target rejection |
| Blockchain trade SQLite | Local trade.db | blockchain-sqlite-health.cjs backup, using better-sqlite3 online backup API | Existing WAL regression creates a backup, checks integrity and opens the snapshot to read the committed fixture row |
| Node cross-source Intelligence PostgreSQL | Separate ETL target configured by INTELLIGENCE_DATABASE_URL | No dedicated production backup job or target-specific backup script was found in this repository snapshot | New producer workflow runs a synthetic PostgreSQL custom-format dump/restore, row check and corrupt-archive rejection |

### Important distinction: two Intelligence stores

The Admin Compose intelligence-worker is the Python runtime using the
intelligence-state SQLite volume. The Node cross-source ETL package uses a
separate PostgreSQL target via INTELLIGENCE_DATABASE_URL. Do not assume these
are the same database or that backing up one protects the other.

The production backup script now requires the potapoff-intelligence worker
container and includes a WAL-consistent SQLite online snapshot. If the worker
container or database file is missing, the backup fails instead of silently
publishing an incomplete recovery set.

The Node ETL PostgreSQL restore rehearsal is synthetic CI only. No deployed
Node ETL PostgreSQL target or its physical backup schedule was verified here.
Before a Node ETL production rollout, assign an owner, backup destination,
encryption, retention, restore cadence and RPO/RTO for that target.

## Operator runbooks

### POTAPoff product, Admin and Python Intelligence

Run only on the trusted deployment host, after verifying host identity and
backup storage capacity:

    BACKUP="$(bash /opt/potapoff-deploy/scripts/backup-production.sh)"
    bash /opt/potapoff-deploy/scripts/verify-backup-restore.sh "$BACKUP"

The backup is promoted only after all three database artifacts, archive
inspection and SHA256 manifest verification succeed. The restore rehearsal
writes only into new PostgreSQL databases inside a temporary --network none
container and a temporary Python container. It does not restore over a live
database or named volume.

The archive contains server configuration and .env files as well as data.
Treat the complete directory as secret material: keep the existing restrictive
permissions, encrypt any off-host copy, restrict access and test key recovery.
Do not upload a real backup directory to CI or a public artifact store.

### X Collector PostgreSQL (Windows)

From x-collector, with DATABASE_URL loaded into the process environment and
PostgreSQL client tools on PATH:

    npm run db:backup:windows

The script creates a custom-format dump, validates its TOC with pg_restore
--list, and retains the configured number of local archives. It does not
restore the live database. Restore only to a newly created disposable database:

    pg_restore --list <archive>
    pg_restore --dbname="$X_RESTORE_CHECK_DATABASE_URL" --no-owner --no-acl --exit-on-error --single-transaction <archive>

Compare migration state, important table counts and source/outbox invariants
before approving a recovery. Never point X_RESTORE_CHECK_DATABASE_URL at the
live source database.

### Telegram Collector PostgreSQL

From tg-collector:

    bash scripts/backup.sh
    TG_RESTORE_CHECK_DATABASE_URL="<empty disposable PostgreSQL URL>" bash scripts/restore-check.sh "<archive path>"

The restore-check script refuses a target containing user objects. It restores
into the explicitly supplied empty database and prints key-table counts. The
CI workflow also compares restored/source message counts and verifies that a
second restore into a non-empty target is rejected.

### Blockchain trade SQLite

From solana-launcher:

    npm run blockchain:db-check
    npm run blockchain:db-backup
    npm run blockchain:db-check -- --db "<path to sqlite-backups/trade-....db>"

The backup uses SQLite's online backup API; do not copy a live trade.db file
or its WAL/SHM files independently. Validate the backup as a separate database
before any recovery. To replace a local working copy, stop all writers, retain
the original database and its recovery metadata, and only then copy the verified
snapshot into the configured path. The RPC recovery-authority/challenge state
has its own anti-rollback purpose; do not silently replace it with an older
trade database snapshot.

### Node cross-source Intelligence PostgreSQL

For an explicitly provisioned non-production target, use a restricted
PostgreSQL service definition or .pgpass file (mode 0600); do not place
passwords in shell history or CI logs. The required sequence is:

    pg_dump --format=custom --no-owner --no-acl --file="<protected archive>" "<non-production connection>"
    pg_restore --list "<protected archive>"
    createdb "<new empty restore database>"
    pg_restore --dbname="<new empty restore database>" --no-owner --no-privileges --exit-on-error --single-transaction "<protected archive>"

After restore, compare migration ledger, intelligence_inbox, token-link
observations, swap-evidence revisions and row counts with the source snapshot.
Never restore into the active target as a test. This repository currently has
only the synthetic CI rehearsal for this Node PostgreSQL target; production
backup scheduling remains an operator gate.

## CI coverage added or reused

- source-producer-to-consumer.yml: real source verifier/emitter modules plus
  destination consumer, with fixture-only RPC and disposable databases.
- x-collector-ci.yml: custom-format PostgreSQL archive round-trip and
  truncated archive rejection.
- tg-collector.yml: existing custom-format PostgreSQL restore rehearsal.
- arch-02-security-backup-ci.yml: product/Admin PostgreSQL backup and
  isolated restore; the rehearsal now also creates, backs up and restores the
  synthetic Python Intelligence SQLite volume.
- source-producer-to-consumer.yml: synthetic Node Intelligence PostgreSQL
  archive restore and corrupted archive rejection.
- blockchain-sqlite-health-regression.cjs: existing WAL-aware SQLite
  snapshot/integrity/readback regression.

## Remaining operator gates

- Verify real database owners, effective PostgreSQL grants and physical
  database locations; repository paths do not prove what is running on a host.
- Configure encrypted off-site storage and retention for each independent
  source/target. TG's optional rclone destination is not automatically encrypted.
- Set and document RPO/RTO per store; rehearse recovery at the intended cadence.
- Verify the Node ETL PostgreSQL target and assign its production backup owner
  before deploying the Node supervisor.
- Verify real X/TG sessions, provider account permissions, Blockchain RPC
  provenance/finality and source completeness in an explicitly approved test
  environment.
- Verify SSH host-key pinning and GitHub branch protection independently.
- Do not describe any CI fixture, mock provider response or local SQLite test
  as a successful production backup, restore, deployment or live E2E test.
