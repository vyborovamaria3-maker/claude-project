# DB ownership — Intelligence 2.2

Each operational database remains the authority for its original observations.
The separate Intelligence PostgreSQL is the authority only for normalized,
versioned cross-platform analytics. No database is migrated or opened by this
document.

| DB | Owner | Owns | Intelligence access |
| --- | --- | --- | --- |
| X PostgreSQL | X Collector | Tweets, authors, revisions, X graph, tasks | Outbox claim/ACK; bounded read-only AI source adapter |
| Telegram PostgreSQL | TG Collector | Messages, edits, deletions, numeric peer IDs | Outbox claim/ACK; bounded read-only AI source adapter |
| Solana SQLite trade.db | **Blockchain module inside Solana Launcher** (logical owner; not an independent deployable service) | Solana wallet observations, parsed swap evidence, revisions and local trade projections | SQLite leased Outbox; no inferred PnL |
| Python Intelligence | Python Intelligence worker | Current Compose: SQLite documents/jobs in `intelligence-state`; PostgreSQL backend exists in code but is not selected by current Compose; MemoryDocumentStore is ephemeral RAM only | Admin mounts current SQLite read-only; central backup covers SQLite only; Memory is not a database |
| Node Intelligence PostgreSQL | Node cross-source Intelligence | Inbox, Registry, Evidence, Timeline, links, features, alerts and backtests | Intended ETL writer / API read-only split; Node runtime has no current production Compose service and live DB is NOT VERIFIED |
| Memecoin PostgreSQL 16 | Memecoin Intelligence app | Its own analytics, graph and jobs | Own Compose stack; not a second cross-platform truth |
| SolSub PostgreSQL 16 | Solana Subscription Service | Users, plans, payments and subscription lifecycle | Own Compose stack; canonical ownership across other products is not yet migrated |
| Telegram MiniApp SQLite | `telegram-miniapp/backend-new` demo backend | Demo users/payments; Prisma schema currently declares SQLite | Standalone/demo; live use NOT VERIFIED |
| Admin PostgreSQL 17 | Admin site | Operator configuration and audit | Administrative observability only |

## Non-negotiable boundaries

- Existing `intelligence_inbox` has PRIMARY KEY
  `(source_system,event_kind,event_key)`. Do not create a duplicate Inbox.
- Source commit -> destination commit -> source ACK. Replayed events must not
  change destination results.
- A ticker or username is not token identity proof. Identity mappings require
  source evidence, version and historical validity.
- An unverified wallet event is not a settled trade or authoritative PnL.
- The new Intelligence layer uses external HTTPS AI APIs with secret-managed
  API keys, not the legacy local Qwen 2.5 7B runtime.
- AI source-reader SQL is currently coupled to X/TG schemas; encrypted text
  snapshots are optional and NOT enabled until encryption, retention, purge and
  privacy controls are deployed.
- Browsers must never receive source DB URLs or the Intelligence API token.
  The loopback-only API requires a separately authenticated backend proxy.

## Backup and release checklist

1. Audit actual DB grants, migrations, checksum ledger and read-only roles.
2. Run disposable X, TG, SQLite and Intelligence integration tests.
3. Use PostgreSQL backups and test restoration in an isolated DB. Compare
   row counts and schemas with the source snapshot. Do not upload real user
   dumps to shared CI without explicit sanitization.
4. Use WAL-aware SQLite online backup, integrity verification and restore.
5. Validate queue replay, late edits, link invalidation, AI costs and covered
   versus unknown source windows before enabling producers.
6. Deploy each source and consumer via explicit opt-in; green CI does not prove
   any live source or provider integration.

### Request-only token reports (migration 016)

The optional authenticated token POST reads X/TG stores through read-only sessions and SQLite token_trades through a read-only handle. It writes only derived reports and usage to the separate Intelligence DB. No raw social text is copied there. Literal address matches are labeled as such, not promoted to verified mappings, and cached legacy trade rows do not prove settlement/PnL. Background ETL/AI flags are unnecessary and remain off in request-only deployment. Source coverage remains unknown when collection completeness is unproven.


## Physical inventory and recovery evidence (2026-10-31; clarified 2026-11-01)

This document is a **logical ownership map**, not proof of the number or location
of physical database instances. Do not infer a physical database count from the
rows above.

The latest operator confirmation recorded in issue #172 states that no
production server was provisioned and deployment was not wanted at that time.
Therefore physical production hosts, actual DB paths, live grants, off-host
backup delivery, restore duration and RPO/RTO remain **NOT VERIFIED**. Reconfirm
this status before any live operation.

### PostgreSQL privilege configuration warning — P0, live state NOT VERIFIED

The repository's Compose configuration currently uses the PostgreSQL image's
`POSTGRES_USER` as the application connection identity:

- `solana-launcher/docker-compose.production.yml`: `POSTGRES_USER=potapoff`
  and the backend `DATABASE_URL` also authenticates as `potapoff`.
- `admin-site/docker-compose.yml`: `POSTGRES_USER=potapoff_admin`
  and `ADMIN_STATE_POSTGRES_DSN` also authenticates as `potapoff_admin`.

The official PostgreSQL image creates the configured `POSTGRES_USER` with
**superuser power on first initialization**. Existing persistent volumes are
not rewritten merely because the environment variable changes on a later
container start. Therefore the repository configuration is a strong warning
that application identities may be superusers on newly initialized databases;
the actual deployed `rolsuper`, memberships and grants remain **NOT VERIFIED**
because no production database was accessed. Do not describe these identities
as least-privilege until the read-only audit proves their actual attributes.
See the [official PostgreSQL image documentation](https://hub.docker.com/_/postgres).

The current central backup script also runs `pg_dump` using these same
configured role names; a separate backup identity has not been provisioned or
verified. This warning concerns the product and Admin state database login
identities; the separate read-only source roles `admin_reader` and
`intelligence_reader` documented in `admin-site/deploy/DEPLOY_ADMIN_POTAPOFF.md`
are a distinct access path and do not resolve the product/Admin state role
question. Before production activation, design and test distinct bootstrap,
migration, runtime and backup roles. Do not assume a new
`docker-entrypoint-initdb.d` script will repair an existing volume: the
official image runs initialization scripts only when the data directory is
empty. Any existing-volume role/ownership migration requires a separately
reviewed, backed-up and reversible operator procedure.

| Store / environment | Physical location | Backup coverage | Restore evidence | Operator |
| --- | --- | --- | --- | --- |
| POTAPoff product PostgreSQL | Compose sets `POSTGRES_USER=potapoff`; backend `DATABASE_URL` uses the same role; live role attributes NOT VERIFIED | Central backup script: `postgres.dump` | Disposable PG restore only; live restore NOT RUN | NOT ASSIGNED |
| Control Center PostgreSQL | Compose sets `POSTGRES_USER=potapoff_admin`; `ADMIN_STATE_POSTGRES_DSN` uses the same role; live role attributes NOT VERIFIED | Central backup script: `admin-postgres.dump` | Disposable PG restore only; live restore NOT RUN | NOT ASSIGNED |
| Blockchain `trade.db` | Production Compose bind-mounts `./data:/app/data`; expected host file is `<deploy-dir>/data/trade.db`, container path `/app/data/trade.db`; owned by a module inside frontend/Launcher, not a separate service | Central backup script now snapshots through SQLite Online Backup API and includes `trade.db` in `SHA256SUMS` | Synthetic WAL fixture + isolated integrity/restore check; real database NOT RUN | NOT ASSIGNED |
| X Collector PostgreSQL 16 | `x-collector/compose.reply.yml` defines `postgres:16-bookworm` and named volume `reply_pg`; live volume NOT VERIFIED | Separate X backup helper; not part of POTAPoff central bundle | X CI disposable restore passed; live restore NOT RUN | NOT ASSIGNED |
| TG Collector PostgreSQL | No TG production Compose service in repo; external/local `DATABASE_URL` supplied to local worker; physical instance NOT IDENTIFIED | Separate TG backup/restore scripts; not part of POTAPoff central bundle | CI disposable PG16 restore passed; live restore NOT RUN | NOT ASSIGNED |
| Python Intelligence SQLite | Compose service `potapoff-intelligence`; named volume `intelligence-state`, file `/var/lib/potapoff-intelligence/intelligence.sqlite3`; this is the selected Compose backend. PostgreSQL backend is code-only in this deployment; MemoryDocumentStore is process memory, not durable | Central bundle: `intelligence.sqlite`, created with SQLite Online Backup API and included in `SHA256SUMS` | Synthetic worker-volume fixture + isolated integrity/restore check; real database NOT RUN | NOT ASSIGNED |
| Node cross-source Intelligence PostgreSQL | `INTELLIGENCE_DATABASE_URL`; physical target NOT IDENTIFIED | No verified production backup job/schedule in this repository | Synthetic custom-format dump/restore only; production restore NOT RUN | NOT ASSIGNED |
| Redis / RabbitMQ volumes | Expected Compose volumes; actual host not provisioned | Not included in the PostgreSQL/SQLite backup set | Recovery policy NOT VERIFIED | NOT ASSIGNED |

### Required evidence before production activation

- Record one row per actual physical database or stateful volume: host/volume,
  database name/path, logical owner, access role, backup command, off-host
  destination, retention, last successful backup, restore rehearsal, RPO, RTO,
  primary operator and backup operator.
- Run `docs/operations/postgres-effective-privileges.sql` with a read-only
  audit connection for each PostgreSQL instance. Explicitly verify that each
  runtime role has `rolsuper=false`, `rolcreatedb=false`,
  `rolcreaterole=false`, `rolreplication=false` and
  `rolbypassrls=false`, and inspect inherited memberships and PUBLIC grants.
  The query is observational; it does not grant, revoke or alter roles.
- Treat the current Compose `POSTGRES_USER`/application-DSN identity reuse as
  a P0 privilege gap until a live audit proves the roles were safely demoted
  or replaced with distinct non-superuser identities.
- Verify X, TG and Intelligence stores independently. A successful
  `trade.db` snapshot does not cover those stores.
- Do not mark a backup as verified until its checksum, isolated restore and
  sample/schema assertions have been recorded against the exact source SHA.
- Keep RPO/RTO as **NOT MEASURED** until an operator times a full restore from
  an actual backup copy. CI fixture duration is not a production RTO.


## Architecture clarification — 2026-11-01

- `trade.db` is a Solana data store owned by the Blockchain module, but the module is physically packaged with Solana Launcher. The production Compose mounts the Launcher `./data` directory into the frontend container at `/app/data`; the backup script reads `/app/data/trade.db`. Do not describe this as a separate Blockchain service or an independent host/volume until an extraction is implemented.
- Python `MemoryDocumentStore` is an in-memory adapter for tests/transient runs. It must not appear in a durable database count or backup inventory.
- Python `PostgresDocumentStore` exists in source, but the Admin Compose selects the SQLite worker volume. Do not claim that Python Intelligence currently runs on PostgreSQL in that Compose.
- Node Intelligence PostgreSQL and Python Intelligence SQLite/PostgreSQL are separate storage domains. The Node runtime is not the Python `intelligence-worker` container.
- The current Compose inventory includes product PG16, Admin PG17, Memecoin PG16, SolSub PG16, and local/CI source databases as separate logical stores. This still does not establish the number of physical production databases.
- Solana is the only target blockchain network. Legacy EVM/Bitcoin compatibility code is tracked for safe deprecation; existing historical rows are not to be deleted automatically.


### Inbox event identity fingerprint — migration 017

The Node Intelligence database owns intelligence_inbox.payload_sha256. It is a SHA-256 fingerprint of the normalized RegistryEvent payload, not a hash of the entire source outbox envelope. New ingestion requires the column and treats an event as a duplicate only when the complete fingerprint matches. A NULL value marks a legacy row whose original payload has not yet been proven; it is not a duplicate-acceptance wildcard.

For an existing destination, migration 017 is additive. Backfill is source-read-only and destination-write-only via intelligence/scripts/backfill-inbox-fingerprints.mjs. Start with dry-run, then use the explicit INTELLIGENCE_FINGERPRINT_BACKFILL_ENABLED=true opt-in with --execute on one bounded source (x, tg or blockchain). The source outbox row must match source system, event kind/key, schema version and evidence source ID. Missing/ambiguous source events are left unverified. Never fabricate a fingerprint from aggregate entity tables or migrate a source database as part of this operation.
