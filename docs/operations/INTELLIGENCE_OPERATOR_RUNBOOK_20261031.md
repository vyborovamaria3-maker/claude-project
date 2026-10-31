# Intelligence operator runbook — pre-production

**Snapshot:** 2026-10-31  
**Mode:** offline / local development only  
**Production activation:** NOT AUTHORIZED / NOT RUN  
**Primary operator:** NOT ASSIGNED  
**Backup operator:** NOT ASSIGNED  
**RPO / RTO:** NOT MEASURED

This runbook records the minimum operating contract for the Node Intelligence
supervisor and its X, Telegram and Blockchain source outboxes. It is not a
deployment authorization.

The latest operator confirmation recorded in issue [#172](https://github.com/vyborovamaria3-maker/claude-project/issues/172)
said there was no production server and deployment was not wanted at that time.
Reconfirm that state before changing it. Do not treat repository CI, Docker
fixtures or a runbook as evidence of a live service.

## 1. Current architecture and verified boundaries

- `intelligence/scripts/supervise.mjs` is a foreground process. It is not a
  cloud worker, Windows service, systemd unit or Docker Compose service.
- Both `INTELLIGENCE_ETL_ENABLED=true` and
  `INTELLIGENCE_SUPERVISOR_ENABLED=true` are required.
- The supervisor validates existing source and destination schemas before
  claiming events. It does not start X/TG collectors, run migrations, open
  browser or MTProto sessions, call Solana RPC, or publish to external accounts.
- The bounded CLI modes remain available: `run.mjs --status` is read-only;
  `run.mjs --once` performs a finite explicitly gated batch.
- PR [#206](https://github.com/vyborovamaria3-maker/claude-project/pull/206)
  adds read-only queue health snapshots and structured stdout alert records,
  but remains open and unmerged in this snapshot. Do not assume those metrics
  exist on `main` until the PR is reviewed and merged.
- The current Prometheus configuration scrapes the main backend at
  `backend:8000/metrics`. It does not scrape the Intelligence supervisor and
  no Alertmanager or external Intelligence alert sink is configured.
- Docker Compose's `restart: unless-stopped` applies to its listed services;
  it does not supervise the standalone Intelligence ETL process.

## 2. Ownership and physical database inventory

Logical ownership is recorded in [DB_OWNERSHIP.md](../DB_OWNERSHIP.md).
That map is not a physical inventory. Exact production hosts, DB names, paths,
volumes, deployed roles and actual connection targets remain NOT IDENTIFIED.

| Component | Logical owner | Required runtime access | Physical instance |
| --- | --- | --- | --- |
| X PostgreSQL | X Collector | Source outbox claim/ACK lifecycle plus only required source reads | NOT IDENTIFIED |
| Telegram PostgreSQL | TG Collector | Source outbox claim/ACK lifecycle plus only required source reads | NOT IDENTIFIED |
| Blockchain `trade.db` | Blockchain collector | SQLite lease/ACK lifecycle on a verified local copy or approved DB | Expected frontend Compose mount `/app/data/trade.db`; live host NOT VERIFIED |
| Python Intelligence SQLite | Python Intelligence worker | Local Python runtime state; Admin reads the shared volume read-only | Expected `intelligence-state` volume at `/var/lib/potapoff-intelligence/intelligence.sqlite3`; central backup artifact `intelligence.sqlite`; live host NOT VERIFIED |
| Node Intelligence PostgreSQL | Node cross-source Intelligence | ETL writer; API reader should be SELECT-only | `INTELLIGENCE_DATABASE_URL` target / physical instance NOT VERIFIED; no verified production backup schedule |
| Admin / product PostgreSQL | Admin / POTAPoff | Dedicated application roles; no shared owner credentials | Production host not provisioned at last confirmation |

Before assigning a host or connection, record one row per physical database:
environment, host or volume, database name/path, logical owner, login role,
secret reference (never secret value), backup location, retention, last backup,
restore evidence, RPO, RTO, primary operator and backup operator.

Do not infer a database count from logical components. Redis and RabbitMQ are
also persistent Compose volumes; their recovery requirements must be decided
separately from PostgreSQL and SQLite dumps.

## 3. PostgreSQL least-privilege audit

The read-only audit query is:
[`postgres-effective-privileges.sql`](postgres-effective-privileges.sql).

Run it separately for each approved PostgreSQL DSN:

```bash
psql "$AUDIT_DSN" -X -v ON_ERROR_STOP=1 \
  -f docs/operations/postgres-effective-privileges.sql
```

The query reports the current database/login/effective role, role attributes,
inherited memberships, database/schema/table/sequence ownership, effective
privileges, PUBLIC table grants and default ACLs. It does not create, grant, revoke, alter
or migrate anything. Never put a DSN or password in a command transcript,
issue, workflow log or this repository.

Required access model before any service is enabled:

- Source collectors retain their own write authority. Intelligence source
  consumers receive only the source-table reads and outbox claim/renew/ACK/NACK
  permissions their adapter actually requires.
- Intelligence ETL receives only required destination DML. API/read-only
  consumers receive SELECT only.
- Schema migrations use a separate migration identity; runtime roles are not
  database owners and are not superusers.
- No inherited role or PUBLIC grant may reintroduce INSERT, UPDATE, DELETE,
  TRUNCATE, DDL or schema CREATE where the service does not need it.
- The Admin X Collector editor allowlist in PR #208 is defense in depth, not a
  substitute for database grants. Actual `ADMIN_X_COLLECTOR_DSN` grants remain
  unverified until an operator runs the audit against the real database.

No live grants have been inspected or changed by this work.

## 4. Local isolated start / stop procedure

Use only disposable PostgreSQL databases and a temporary copy of SQLite. Never
point this procedure at a live user database merely to test startup.

From PowerShell:

```powershell
cd intelligence
npm run build

$env:INTELLIGENCE_ETL_ENABLED = 'true'
$env:INTELLIGENCE_SUPERVISOR_ENABLED = 'true'

# Set only disposable test DSNs and a temporary SQLite copy.
# $env:X_SOURCE_DATABASE_URL = '<disposable X source DB>'
# $env:TG_SOURCE_DATABASE_URL = '<disposable TG source DB>'
# $env:SOLANA_TRADE_DB_PATH = '<absolute path to temporary trade.db>'
# $env:INTELLIGENCE_DATABASE_URL = '<disposable destination DB>'

node scripts/supervise.mjs --sources tg --max-batches 1
```

For a single bounded source, use `--sources x`, `--sources tg` or
`--sources blockchain`. Do not select a source until its schema and destination
migrations have been verified. Blockchain requires the corresponding revision
schema. Keep source producer opt-ins separate and disabled by default.

Stop with Ctrl+C (SIGINT). Wait for the supervisor's stopped/summary output and
process exit before starting another instance. The supervisor stops new claims
and drains active work before closing its pools. Do not run two supervisors
against the same source outbox. Do not use an unbounded `--max-batches 0`
process outside a reviewed operator rehearsal.

Restart procedure for local tests:

1. Stop the current process gracefully; do not kill it while a batch is active.
2. Confirm the process exited and no local test process still owns the source.
3. Run the read-only `node scripts/run.mjs --source tg --status` check (substitute `x` or `blockchain` when checking another source).
4. Confirm the previous failure cause is understood and the destination/source
   schema versions are compatible.
5. Restart with a finite `--max-batches 1` test first.
6. Check duplicate-safe replay, ACK-after-destination-commit and lease fencing.

There is no approved production process-manager unit or automatic restart
policy for the Intelligence supervisor. Do not create one until an accountable
operator, alert sink, backup/restore evidence and rollout/rollback procedure
have been approved.

## 5. Monitoring, alert delivery and DLQ

The current main Prometheus scrape target is the application backend only.
PR #206's proposed supervisor health records are structured stdout JSON, not an
external notification service. They do not provide durable alert history across
process restarts.

Before a production process can be enabled, an operator must:

- Select and approve an external log/alert sink and its credentials boundary.
- Route only allowlisted alert codes and bounded metadata; never forward raw
  social payloads, DSNs, tokens, session data or provider exception text.
- Persist alert history and deduplicate by stable alert identity, not only
  in-process memory.
- Test one alert and one recovery transition end-to-end, including delivery
  failure and alert-sink outage.
- Define thresholds, acknowledgement expectations, escalation and quiet-hour
  policy with the named operator.

DLQ handling is manual until a reviewed operator requeue command exists. Capture
the event key, source, attempts, safe error code and destination state. Fix the
root cause before replay. Never delete or requeue rows with ad-hoc SQL and never
weaken retry limits to make the queue appear healthy.

## 6. Backup and recovery

The central POTAPoff backup bundle is being extended in this branch to include:

- product PostgreSQL dump;
- Control Center PostgreSQL dump;
- `trade.db`, captured from the running frontend container using the SQLite
  Online Backup API so committed WAL pages are included;
- deployment and Control Center configuration files;
- a SHA256 manifest over the complete recovery set.

The updated isolated rehearsal validates the manifest, restores the two
PostgreSQL dumps into a network-isolated temporary Docker container, restores
the SQLite snapshot to a fresh temporary path, and rejects corruption. The CI
fixture also keeps a SQLite writer open with a committed WAL row and asserts
that the row appears in the snapshot.

This is synthetic evidence only. It does not prove that a real host has been
backed up, that the backup was copied off-host, or that an actual production
restore was timed. X Collector PostgreSQL, TG Collector PostgreSQL and any
separate Intelligence store require independent backup and restore evidence;
they are not silently covered by the POTAPoff product bundle.

Never copy a live `trade.db` file directly. Do not restore over an open
database. Keep RPO and RTO as NOT MEASURED until a named operator completes a
restore from an actual backup copy and records elapsed time and data coverage.

## 7. Activation gates

| Gate | Current status |
| --- | --- |
| Main source/destination supervisor | Foreground local code exists; production operation NOT RUN |
| PR #206 queue health metrics | Open / unmerged |
| External Intelligence alert sink | NOT CONFIGURED |
| Supervisor process manager / automatic restart | NOT CONFIGURED |
| Physical production DB inventory | NOT IDENTIFIED |
| Actual PostgreSQL grants | NOT VERIFIED |
| Actual host backup / off-host copy | NOT RUN |
| Real backup restore rehearsal | NOT RUN |
| RPO / RTO | NOT MEASURED |
| Primary / backup operator | NOT ASSIGNED |
| Production deployment | NOT REQUESTED / NOT RUN |

Do not close issues [#172](https://github.com/vyborovamaria3-maker/claude-project/issues/172)
or [#174](https://github.com/vyborovamaria3-maker/claude-project/issues/174)
based on CI alone. Issue [#170](https://github.com/vyborovamaria3-maker/claude-project/issues/170)
still requires repository-admin branch protection and required-check configuration.
