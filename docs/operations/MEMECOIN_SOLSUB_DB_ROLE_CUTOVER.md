# Memecoin Intelligence / Solana Subscription Service — PostgreSQL role cutover

**Status:** role provisioning, runtime separation and disposable CI rehearsal are implemented in the integration branch. Existing production-volume ownership cutover has **not** been executed.

This runbook applies to:

- `memecoin-intelligence/docker-compose.production.yml`
- `solana-subscription-service/docker-compose.prod.yml`

## Role model

| Identity | Purpose | Allowed access |
|---|---|---|
| Bootstrap (`POSTGRES_USER`) | PostgreSQL initialization and role provisioning only | Administrative; never used by API, worker, bot or web |
| `*_migrator` | One-shot schema migrations and seed | Schema DDL; owns objects it creates |
| `*_app` | API/worker/bot runtime | SELECT, INSERT, UPDATE, DELETE; no schema creation |
| `*_readonly` | Admin/source inspection | SELECT only; read-only transactions |

The provisioner is idempotent, rejects restricted identities as its bootstrap login, removes role memberships from restricted roles, and sets default privileges for objects created by the migration identity. It pre-provisions `pgcrypto` for Memecoin Intelligence and ensures the default `public` schema exists as bootstrap. Solana Subscription's immutable Prisma initial migration still executes `CREATE SCHEMA IF NOT EXISTS public`, which PostgreSQL requires database-level CREATE for even when the schema already exists. The migration-only wrapper temporarily grants CREATE to the migrator only around `prisma migrate deploy`, then revokes it on success or on shell exit; it must never remain on the runtime role. Keep initial SQL/Prisma migrations immutable.

The application containers do not receive the bootstrap or migrator passwords. SolSub Web receives only public `NEXT_PUBLIC_*` configuration. Deployment `.env` files are excluded from both Docker build contexts.

## Fresh database deployment

Use unique, high-entropy values for bootstrap, app, migrator and read-only passwords. Do not reuse one password across roles. Both production Compose files attach to the external `potapoff_default` network; ensure it exists (normally created by the main Solana Launcher stack) before starting either stack.

For Memecoin Intelligence:

```bash
cd memecoin-intelligence
cp .env.example .env
# Fill all required values; keep .env outside version control.
docker compose -f docker-compose.production.yml --profile migrate run --rm migrator
docker compose -f docker-compose.production.yml up -d
```

For Solana Subscription Service:

```bash
cd solana-subscription-service
cp .env.example .env
# Fill all required values, including public web build configuration.
docker compose -f docker-compose.prod.yml --profile migrate run --rm migrator
docker compose -f docker-compose.prod.yml up -d
```

The migration profile starts PostgreSQL and the role provisioner as dependencies, then runs migrations with the dedicated migrator identity. The normal API/worker/bot services use only the app identity.

## Existing database volumes — mandatory cutover gate

**Do not start the updated production Compose stack, run its role provisioner, or run the migration profile against an existing production volume until the ownership cutover has been rehearsed and approved.**

The role provisioner runs automatically when the stack starts. It creates/rotates the restricted role credentials and changes grants on existing public objects. It intentionally does not transfer existing table, sequence, type, view, function or schema ownership. Existing objects may still belong to the former bootstrap identity; a non-owner migrator cannot alter them merely because it has schema CREATE.

Before cutover:

1. Take an encrypted off-host backup of the exact database and verify a restore into an isolated PostgreSQL instance.
2. Run `docs/operations/postgres-role-cutover-inventory.sql` against the isolated restore and record every application-owned object.
3. Build an explicit, reviewed ownership-transfer allowlist for that database. Do not use database-wide `REASSIGN OWNED` and do not transfer extension-owned objects.
4. Rehearse forward transfer, migrations, runtime DML, read-only access, rollback and re-application on the isolated restore.
5. Confirm the application can start and pass health checks using the app identity before changing production traffic.
6. Schedule an approved maintenance window, retain the bootstrap credential offline for rollback, and execute only the reviewed per-object transfer.
7. Re-run the inventory and effective-privilege checks after cutover.

No production migration, volume modification, credential rotation or ownership transfer is performed by this PR.

## Verification

The predeploy workflow runs `.github/scripts/test-readonly-source-roles.sh` against disposable PostgreSQL 16 containers. It verifies:

- idempotent provisioning;
- distinct, non-superuser app/migrator/read-only roles;
- no restricted-role memberships or escalation to bootstrap;
- runtime DML on existing and migration-created tables;
- migrator-only schema creation and alteration without database-level CREATE;
- default privileges for future tables and sequences;
- read-only SELECT and rejection of write privileges;
- rejection when the provisioner is invoked as any restricted identity;
- the real Memecoin SQL migration chain under the migrator identity.

The SolSub quality workflow separately applies the real Prisma migrations and seed using `solsub_migrator`, then verifies app DML, read-only SELECT and DDL denial.

Compose and Dockerfile regression tests verify that runtime services use app credentials, migration services are opt-in one-shot jobs, the SolSub API runner starts Node directly (the runtime image intentionally has no npm CLI), and deployment `.env` files are excluded from Docker build contexts.

## Operational caveat

The new Compose configuration requires `POSTGRES_APP_PASSWORD` and `POSTGRES_MIGRATOR_PASSWORD` in addition to the existing bootstrap and read-only credentials. Populate these in the deployment secret store before an approved deployment. Existing volumes remain **blocked** until the ownership inventory and restore rehearsal are complete.

Memecoin's migration no longer tries to install `pgcrypto`: PostgreSQL 16 provides `gen_random_uuid()` in core, so the migration role does not need database-level CREATE just to install an extension.
