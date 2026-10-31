# DB ownership — Intelligence 2.2

Each operational database remains the authority for its original observations.
The separate Intelligence PostgreSQL is the authority only for normalized,
versioned cross-platform analytics. No database is migrated or opened by this
document.

| DB | Owner | Owns | Intelligence access |
| --- | --- | --- | --- |
| X PostgreSQL | X Collector | Tweets, authors, revisions, X graph, tasks | Outbox claim/ACK; bounded read-only AI source adapter |
| Telegram PostgreSQL | TG Collector | Messages, edits, deletions, numeric peer IDs | Outbox claim/ACK; bounded read-only AI source adapter |
| Solana SQLite trade.db | Blockchain collector | Wallet observations and local trades | SQLite leased Outbox; no inferred PnL |
| Node Intelligence PostgreSQL | Node Intelligence | Inbox, Timeline, verified links, source evidence, features, signals and backtests | ETL writer role; API reader SELECT-only |
| Python Intelligence SQLite | Python Intelligence worker | Normalized documents and durable jobs | Worker writes the shared `intelligence-state` volume; Admin mounts the same database read-only |
| Legacy memecoin PostgreSQL | Memecoin app | Legacy analytics | Read-only compatibility, not a second cross-platform truth |
| Admin DB | Admin site | Operator configuration and audit | Administrative observability only |

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


## Physical inventory and recovery evidence (2026-10-31)

This document is a **logical ownership map**, not proof of the number or location
of physical database instances. Do not infer a physical database count from the
rows above.

The latest operator confirmation recorded in issue #172 states that no
production server was provisioned and deployment was not wanted at that time.
Therefore physical production hosts, actual DB paths, live grants, off-host
backup delivery, restore duration and RPO/RTO remain **NOT VERIFIED**. Reconfirm
this status before any live operation.

| Store / environment | Physical location | Backup coverage | Restore evidence | Operator |
| --- | --- | --- | --- | --- |
| POTAPoff product PostgreSQL | Production host not provisioned / NOT IDENTIFIED | Central backup script: `postgres.dump` | Disposable PG restore only; live restore NOT RUN | NOT ASSIGNED |
| Control Center PostgreSQL | Production host not provisioned / NOT IDENTIFIED | Central backup script: `admin-postgres.dump` | Disposable PG restore only; live restore NOT RUN | NOT ASSIGNED |
| Blockchain `trade.db` | Expected Compose mount `/app/data/trade.db`; host path depends on deploy directory | Central backup script now snapshots through SQLite Online Backup API and includes `trade.db` in `SHA256SUMS` | Synthetic WAL fixture + isolated integrity/restore check; real database NOT RUN | NOT ASSIGNED |
| X Collector PostgreSQL | Local/remote physical instance NOT IDENTIFIED | Separate Windows backup helper; not part of the POTAPoff central bundle | Actual isolated restore NOT RUN | NOT ASSIGNED |
| TG Collector PostgreSQL | Local/remote physical instance NOT IDENTIFIED | Separate TG backup/restore scripts; not part of the POTAPoff central bundle | CI disposable restore is distinct from any live restore | NOT ASSIGNED |
| Node Intelligence PostgreSQL destination | Separate Node ETL/API destination; physical instance NOT IDENTIFIED | Not included in the central POTAPoff recovery bundle; separate backup/restore required | NOT RUN | NOT ASSIGNED |
| Python Intelligence SQLite | Compose named volume `intelligence-state`; worker path `/var/lib/potapoff-intelligence/intelligence.sqlite3`; actual host mount NOT VERIFIED | Central bundle includes `intelligence.sqlite` via SQLite online backup and SHA256 manifest | Synthetic isolated restore/integrity/corruption/missing-source CI passed; live restore NOT RUN | NOT ASSIGNED |
| Redis / RabbitMQ volumes | Expected Compose volumes; actual host not provisioned | Not included in the PostgreSQL/SQLite backup set | Recovery policy NOT VERIFIED | NOT ASSIGNED |

### Required evidence before production activation

- Record one row per actual physical database or stateful volume: host/volume,
  database name/path, logical owner, access role, backup command, off-host
  destination, retention, last successful backup, restore rehearsal, RPO, RTO,
  primary operator and backup operator.
- Run `docs/operations/postgres-effective-privileges.sql` with a read-only
  audit connection for each PostgreSQL instance. The query is observational;
  it does not grant, revoke or alter roles.
- The central bundle covers product/Admin PostgreSQL, Blockchain `trade.db`
  and Python Intelligence `intelligence.sqlite`. It does **not** cover X/TG
  PostgreSQL or the separate Node Intelligence PostgreSQL destination; those
  still need independent backup and restore evidence.
- Do not mark a backup as verified until its checksum, isolated restore and
  sample/schema assertions have been recorded against the exact source SHA.
- Keep RPO/RTO as **NOT MEASURED** until an operator times a full restore from
  an actual backup copy. CI fixture duration is not a production RTO.
