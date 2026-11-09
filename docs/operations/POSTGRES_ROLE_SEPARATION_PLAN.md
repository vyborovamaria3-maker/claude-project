# PostgreSQL role separation — staged plan (P0, NOT DEPLOYED)

**Status:** design, deployment wiring and disposable CI rehearsal only. No production role or ownership migration has been executed. This is NOT evidence of a completed production cutover.
**Scope:** POTAPoff product PostgreSQL 16, Control Center PostgreSQL 17.
**Tracking:** #172 (physical inventory/recovery), #170 (main protection); PR #212 (recovery integration), PR #215 (deployment guard and isolated role-provisioner rehearsal).
**2026-11-01 baseline:** product Compose uses `POSTGRES_USER=potapoff` and the backend,
Celery worker/beat, discovery daemon and optional Telegram monitor connect as
`potapoff`. Admin Compose uses `POSTGRES_USER=potapoff_admin` and the Admin
DSN connects as `potapoff_admin`. The central `backup-production.sh` uses
both identities for `pg_dump`. Actual live role attributes, ownership and
deployments have **NOT** been inspected.

## Intended permission boundaries

| Identity | Scope | Permitted | Never permitted |
| --- | --- | --- | --- |
| Bootstrap DBA (one per instance) | Initial cluster/DB setup, emergency administration only | SUPERUSER in official image; restricted offline operator access | Application connection, scheduled backup, Celery, migrations |
| Migration login (one per DB) | Reviewed deployment job only | Own application schemas/objects; CREATE/ALTER/DROP within approved app scope | SUPERUSER, CREATEDB, CREATEROLE, REPLICATION, BYPASSRLS, cross-DB access |
| Runtime login (one per DB) | API, jobs and Admin runtime | CONNECT, app schema USAGE, required DML and sequence use | Ownership, schema CREATE, DDL, role management, superuser, blanket default grants |
| Backup login (one per DB) | Scheduled pg_dump only | CONNECT, schema USAGE, SELECT on all required relations and sequences; narrow metadata permissions as needed | DML, DDL, ownership, role management, superuser, login as migration |

Use separate secrets for each login and database; rotate all shared legacy
credentials after the cutover. Keep bootstrap secrets **outside** runtime and
regular backup containers. Do not invent credentials, check them into Git, or
copy actual dumps to public CI. For future fresh installations, use a distinct
bootstrap `POSTGRES_USER` and an operator-reviewed init sequence; setting
`POSTGRES_USER` on an existing volume does **not** rename, demote, or create
PostgreSQL roles. Do not install an automatic live `docker-entrypoint-initdb.d`
role-migration script for existing volumes.

**Important:** database/schema/object ownership is NOT equivalent to
`GRANT ALL`. Alembic must run as an owner (or via an explicitly reviewed
`SET ROLE` path); existing tables, sequences, views, functions, types,
`alembic_version`, extension objects and default privileges must be inventoried
before transferring ownership. Do **not** apply `REASSIGN OWNED` blindly:
it affects all owned objects in the current DB and may include unrelated
objects. Review extension-managed objects and RLS separately. `pg_dump`
as a non-superuser can fail when SELECT is missing or RLS prevents a full
dump; treat failure as a blocker, never bypass by silently falling back to
the superuser.

## Phased operator procedure (manual approval required)

### 0. Read-only evidence and recovery preconditions

- Confirm whether any live instance/volume exists; identify exact product/Admin
  physical DB, version, schema, owner, app DSN source, tasks and scheduled jobs.
- On each instance, run `docs/operations/postgres-effective-privileges.sql`
  from a restricted read-only connection; record `rolsuper`, `rolcreatedb`,
  `rolcreaterole`, `rolreplication`, `rolbypassrls`, membership, PUBLIC
  grants and all schema/table/sequence/default-ACL owners. Redact credentials
  and sensitive data in evidence.
- Inventory every app write path including background jobs, Alembic and
  `alembic_version`; identify every `pg_dump`/restore invocation. Record
  any RLS, materialized views, extensions, FDWs and sequences.
- Take a verified encrypted backup, store it off-host, **restore it to an
  isolated destination**, verify checksums, schemas and representative counts,
  and record the measured recovery time, point and approver. No cutover with
  unverified restore, unassigned primary/backup operator or missing rollback.

### 1. Design and rehearsal on an isolated copy

- Prepare a reviewed, per-object ownership inventory and ordered SQL change
  set on the **copy**, including grants for existing objects and
  `ALTER DEFAULT PRIVILEGES FOR ROLE <actual object creator>` for future
  tables/sequences. Do not grant schema CREATE to runtime or backup.
- Keep the image bootstrap DBA separate. Introduce non-superuser migration,
  runtime and backup identities with distinct credentials. Migration login
  must own every object it must subsequently ALTER; check ownership and
  extension compatibility before any transfer.
- Verify old and new application versions' startup and every real migration
  path using **migration** credentials only. Verify API/worker/Admin DML and
  sequence usage with runtime credentials only; negative tests must reject
  ALTER, CREATE ROLE, unauthorized cross-schema access and privilege escalation.
- Use backup credentials to create the complete custom-format dumps, including
  any RLS-sensitive relations, then restore to another isolated instance and
  confirm real data/sequence invariants. Validate credential authentication
  using the intended production `pg_hba.conf`/TLS policy, not fixture trust.
- Run both a forward cutover and a rollback rehearsal, including revoked
  permissions, rotated credentials, long-running connection pools, scheduled
  backup and backup failure alerts. Record CI SHA, isolated run logs and
  sign-off; the CI fixture by itself is insufficient.

### 2. Separate approved rollout (NOT part of PR #212)

- Maintenance window; backup and validate restore first. Freeze migrations and
  all writers; capture transaction/session baseline and role/ACL snapshot.
- Apply the **reviewed** role and ownership/grant migration transactionally
  where supported; avoid destructive blanket revocations until verification.
  Keep the old login usable for rollback at first.
- Change migration-job DSN separately from runtime DSN. Change API, Celery,
  discovery and optional monitors **together** only after compatibility checks.
  Change Admin DSN and any independent Admin migrations in their own window.
  Update backup job to use dedicated backup login over authenticated TCP
  (not implicit local-socket trust) and verify both scheduled dump and restore.
- Verify effective grants and non-superuser status, migrations, runtime reads/
  writes, backup completeness and logs. Rotate/revoke legacy app login secrets
  after the rollback window closes; preserve an offline DBA break-glass path.

### 3. Rollback decision and stop conditions

If migration, DML, sequence allocation, backup, restore, connection pool,
health or least-privilege assertions fail: STOP; do **not** continue role
revocation or deploy. Stop writers, restore previous **known-working** DSNs
and image, retain the prior bootstrap login temporarily, and restore the
reviewed role/ACL/ownership state from a versioned operator SQL plan. Because
object ownership changes may not be reversed merely by reverting a DSN,
the **reverse ownership mapping must be validated on the isolated copy**
before approval. Database restore is a last-resort **destructive** recovery
requiring explicit operator sign-off, never an automatic answer to a bad grant.
Record actual restore point and reconciliation of writes around the window.

Do not mark P0 complete until actual production login isolation, schema
ownership, audited grants, independent backup scheduling, off-host copies,
successful *real* isolated restore and measured RPO/RTO are all evidenced.

## PR #215 deployment wiring — still not a live cutover

The POTAPoff product deployment now has a dedicated role provisioner and a
fail-closed ownership preflight. These are code paths and disposable CI
rehearsals only; they have **not** been run against a production database.

`solana-launcher/scripts/provision-postgres-roles.sql`:

- runs only as the configured bootstrap superuser and rejects identity reuse;
- creates/refreshes app, migrator, backup and read-only logins as
  `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`;
- removes stale role memberships from those restricted identities;
- grants app DML, backup/read-only explicit SELECT, and migrator CREATE on
  `public`, with matching default privileges for future migration objects;
- revokes PUBLIC database and schema access;
- keeps backup/read-only transactions read-only;
- does **not** run `REASSIGN OWNED`, change database ownership, or change
  schema ownership. The backup role is not granted `pg_read_all_data` and
  cannot bypass RLS. A dump that cannot see all rows because of RLS must fail
  and be investigated rather than silently omit data.

The provisioner is intentionally not an ownership migration. The deploy
sequence creates/refreshes roles so the dedicated backup login is available,
takes and verifies the backup, then runs
`solana-launcher/scripts/check-postgres-migrator-ownership.sql` **before
stopping writers or invoking Alembic**. The guard is read-only and blocks if
any non-extension application relation, routine or user-defined domain/enum/
range type is not owned by the migration login, or if the migration login
lacks CREATE on `public`.

If the guard blocks, stop. Run the catalog inventory on an isolated restored
copy, prepare and rehearse a per-object ownership/ACL allowlist and its reverse
map, then apply it only in a separately approved maintenance window. Never
bypass the guard, reintroduce `REASSIGN OWNED`, or promote the migration login
to database owner as a shortcut. The isolated regression
`.github/scripts/test-potapoff-role-provisioner.sh` proves that provisioning
leaves legacy owners unchanged, the guard rejects the legacy state, and an
explicit test-only allowlist makes the guard pass.

## Narrow automated rehearsal in PR #212

`.github/scripts/test-postgres-role-separation.sh` uses two completely
disposable PostgreSQL containers (16 and 17) and disposable restore targets
with `--network none` and **no host ports or real credentials**.
It verifies that distinct migration/runtime/backup logins are non-superuser,
migration owns/changes its own table, runtime can use DML and a serial
sequence but not DDL/escalation, backup can SELECT/dump but not write,
new tables inherit only intended default grants, and an isolated custom
archive restore contains the committed rows. The fixture also creates
previously populated **bootstrap-owned** tables, a sequence, a view, a SQL
function and the Alembic ledger. It explicitly transfers these owners and
the corresponding ACLs, confirms runtime/backup boundaries, rehearses
an **allowlisted reverse ownership and ACL migration**, then reapplies the
forward migration without losing committed rows or the sequence value.
It does **not** issue blanket `REASSIGN OWNED` or run against a live database.

Unlike earlier trust-auth fixtures, the role-separation rehearsal now uses
SCRAM-SHA-256 over container-local TCP with **CI-only hardcoded fixture
passwords** and verifies an incorrect password is rejected. PostgreSQL
containers still run with `--network none` and no published ports; their
credentials are **not** deployable credentials. This does **not** establish
production TLS, secret rotation, real existing-object ownership transfer,
extension/RLS safety, complete access requirements, or a production restore.
Do not use these synthetic credentials/fixtures on any real database.

The separate `.github/scripts/test-backend-alembic-restricted.sh` test
executes the **actual full Alembic graph** on an additional newly created
isolated PostgreSQL 16 DB under a non-superuser migration role and checks
the role and object ownership. It tests a **fresh** app database, not an
upgrade of the real populated database. The existing bootstrap-backed
migration regression remains in the predeploy workflow.

## Catalog-only inventory before proposing a real cutover

Use `docs/operations/postgres-role-cutover-inventory.sql` **on the
isolated restored copy first**, and only on a live instance after the operator
approves read-only metadata access. Example (no passwords on the command line):

```bash
# In an approved operator environment with a restricted audit DSN already
# set by the operator; do NOT point this at an unapproved production host.
: "${PGHOST:?audit PGHOST required}"
: "${PGUSER:?restricted audit PGUSER required}"
: "${PGDATABASE:?audit PGDATABASE required}"
umask 077
psql -X -v ON_ERROR_STOP=1 -f \
  docs/operations/postgres-role-cutover-inventory.sql \
  > role-cutover-inventory.txt
```

The script has a `REPEATABLE READ READ ONLY` transaction and queries only
PostgreSQL catalogs: login flags/memberships, database and schema ACL,
table/view/sequence/foreign-table owners, routine owners and SECURITY
DEFINER, types/domains/enums, extensions, RLS presence, default privileges
and foreign-server metadata (no connection options). It does **not** read
application rows, print password hashes, inspect live secrets, alter grants,
execute untrusted application functions or generate/apply DDL. The inventory
is **not** comprehensive proof of effective permissions: operators must also
review object dependencies, extension-managed items, actual RLS expressions,
schema-qualified routines, large objects, event triggers and all service
connection identities. Restrict access to inventory output; even metadata
can expose internal system structure.

Compare catalogs before transfer, after forward change, after the explicit
reverse map and after reapplying forward. The fixture CI uses the same
catalog-only inventory through an unprivileged backup role and requires a
round-trip equality of catalog reports. For a real populated DB, do not
blindly expect byte-identical reports across PostgreSQL upgrades, DDL,
extension changes or concurrent sessions; review differences and object
identities explicitly with a signed-off object-level manifest.

**Stop conditions:** unexpected owner, RLS policy, SECURITY DEFINER routine,
extension/FDW dependency, ungranted sequence, PUBLIC grant, lost default ACL,
missing expected table or unknown migration owner. Do not automatically
generate, execute or roll back `REASSIGN OWNED` from this metadata.

## Admin PostgreSQL 17: schema DDL at startup (P0)

The Control Center originally executes `CREATE TABLE IF NOT EXISTS` and
`CREATE INDEX IF NOT EXISTS` inside constructors in
`admin-site/app/postgres_admin_state.py`,
`postgres_security_store.py`, and `postgres_task_queue.py`. Merely granting
DML to a new runtime role would therefore risk startup failure. An Alembic
PASS for the product's separate PostgreSQL 16 database does not cover this
Admin-specific issue.

PR #212 adds **opt-in** `ADMIN_PG_SCHEMA_MODE=preprovisioned`. In this
mode the Admin's PostgreSQL store constructors no longer run CREATE DDL.
Before app initialization, a read-only preflight checks that the required
tables, indexes and sequences already exist, are owned by a *different*
role, and have necessary DML/sequence rights; it rejects superuser and
other elevated runtime flags, public-schema CREATE permissions and table
RLS. Expired-session cleanup still uses runtime DML. Invalid modes fail
closed. The existing default remains **legacy**; no live Admin is switched
to the restricted path by this PR.

`admin-site/scripts/test_postgres_preprovisioned_roles.py` is **CI-only**:
it requires the exact disposable Admin PostgreSQL 17 workflow DSN and
`GITHUB_ACTIONS=true`, creates an additional fixture DB owned by a
non-superuser migration login, initializes the **existing real Admin
schema** as that login, grants DML/sequence use to an independent
non-superuser runtime login, then starts the five actual Admin stores in
`preprovisioned` mode. The test rejects runtime CREATE/ALTER/CREATEROLE,
checks that runtime startup creates no objects, proves example data writes,
and requires missing permissions and indexes to fail preflight.

This is **not a production schema migration mechanism** and it is **not**
permission to turn on the mode in an existing live installation. Before
deploying it, an operator must verify the actual full schema including
all existing indexes/extensions, approve a separate migration/ownership
script and reverse map, verify all Admin routes/workers and backup on an
isolated copy with real-like data, establish protected credentials, and
measure restore/RPO/RTO. Any new Admin PostgreSQL store or index must be
added to `postgres_schema_policy.TABLES/INDEXES` and the matching CI test.

## Recovery-review follow-up: owner/ACL fidelity and app schema contracts

The review follow-up introduces two **separate** isolated recovery assertions:

1. `verify-backup-restore.sh` still performs a quick data-only
   `--no-owner --no-acl` restore, but now requires a populated product
   Alembic migration ledger and critical Admin tables/columns. This verifies
   *schema viability*, not arbitrary application business-data correctness.
2. The same verifier additionally starts disconnected PostgreSQL **16 and 17**
   targets to restore the role-aware custom archives **without**
   `--no-owner`/`--no-acl`. It replays the matching
   `pg_dumpall --globals-only --no-role-passwords` SQL and compares an exact
   catalog-only owner/ACL fingerprint captured alongside each archive.
   The canonical query is
   `solana-launcher/scripts/postgres-role-restoration-fingerprint.sql` and
   is deployed next to the backup/restore commands.

Each completed recovery set now includes
`postgres-roles.sql`, `admin-postgres-roles.sql`,
`postgres-role-fingerprint.txt`, and
`admin-postgres-role-fingerprint.txt`, in addition to the original data
artifacts. All are included in the strict SHA256 manifest and private backup
directory. The role files contain **no password hashes**, so operators must
restore/rotate protected service credentials separately; keep the whole bundle
restricted because the other backed-up environment files contain secrets.
Role replay is **only** allowed inside the disconnected rehearsal container,
not on a production server. A missing role manifest, owner mismatch or missing
critical schema fails the verify gate.

For the Admin runtime, `ADMIN_PG_SCHEMA_MODE=preprovisioned` now checks
every expected column type/nullability, primary-key columns and exact index
table/key/predicate, plus CREATE/ownership across **all** non-system schemas.
It rejects arbitrary existing side schemas with writable DDL, rather than
checking only `public`. The CI fixture changes a column type, removes a PK,
reuses an index name on the wrong table and grants CREATE on another schema;
each must be rejected. It also performs a FastAPI TestClient app/lifespan/API
smoke under the restricted PostgreSQL 17 DSN.

**Limits:** restoring a full production backup on an isolated host still
requires an operator-owned environment with the real backup, real-sized
datasets, service credentials, application smoke tests, off-host storage and
measured RPO/RTO. Synthetic fixture PASS is not authorization for a live
role migration, merge or deploy.
