#!/usr/bin/env bash
# Runs the ACTUAL POTAPoff Alembic graph on a new disposable PostgreSQL 16
# database owned by a non-superuser migration login. CI-only; no live DSNs.
set -Eeuo pipefail

if [[ "${GITHUB_ACTIONS:-}" != true ||
      "${ENVIRONMENT:-}" != test ||
      "${DATABASE_URL:-}" != 'postgresql+asyncpg://potapoff:ci-postgres-password@127.0.0.1:55433/potapoff_ci' ]]; then
  echo 'Refusing restricted Alembic rehearsal outside the dedicated predeploy CI PostgreSQL fixture' >&2
  exit 2
fi
test -f alembic.ini

python - <<'PY'
import asyncio
import asyncpg

async def setup():
    conn = await asyncpg.connect(
        host="127.0.0.1", port=55433, database="postgres",
        user="potapoff", password="ci-postgres-password",
    )
    try:
        await conn.execute(
            "CREATE ROLE role_ci_migration LOGIN NOSUPERUSER NOCREATEDB "
            "NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'ci-role-migration-only'"
        )
        await conn.execute(
            "CREATE ROLE role_ci_runtime LOGIN NOSUPERUSER NOCREATEDB "
            "NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'ci-role-runtime-only'"
        )
        await conn.execute(
            "CREATE DATABASE potapoff_role_ci OWNER role_ci_migration"
        )
    finally:
        await conn.close()

    migrated = await asyncpg.connect(
        host="127.0.0.1", port=55433, database="potapoff_role_ci",
        user="role_ci_migration", password="ci-role-migration-only",
    )
    try:
        # Restrict accidental PUBLIC CREATE on the app schema explicitly.
        await migrated.execute("REVOKE CREATE ON SCHEMA public FROM PUBLIC")
        # A database owner can connect, create and own its own app objects but
        # does NOT have cluster-wide superuser powers.
        flags = await migrated.fetchrow(
            "SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, "
            "rolbypassrls FROM pg_roles WHERE rolname=current_user"
        )
        assert flags is not None and not any(flags.values()), flags
        assert await migrated.fetchval(
            "SELECT pg_get_userbyid(datdba) FROM pg_database "
            "WHERE datname=current_database()"
        ) == "role_ci_migration"
    finally:
        await migrated.close()

asyncio.run(setup())
PY

# Never use the bootstrap account or production DSN for the real Alembic run.
export DATABASE_URL='postgresql+asyncpg://role_ci_migration:ci-role-migration-only@127.0.0.1:55433/potapoff_role_ci'
alembic upgrade heads
expected="$(alembic heads | awk '{print $1}')"
actual="$(alembic current | awk '/^[0-9][0-9]/ {print $1}')"
[[ -n "$expected" && "$actual" == "$expected" ]] || {
  echo "Restricted-role Alembic head mismatch: expected=$expected actual=$actual" >&2
  exit 1
}

python - <<'PY'
import asyncio
import asyncpg

async def inspect():
    migration = await asyncpg.connect(
        host="127.0.0.1", port=55433, database="potapoff_role_ci",
        user="role_ci_migration", password="ci-role-migration-only",
    )
    try:
        # No application-owned user table/sequence/view may silently inherit
        # the fixture bootstrap superuser's ownership.
        objects = await migration.fetch(
            "SELECT n.nspname, c.relname, pg_get_userbyid(c.relowner) AS owner "
            "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
            "WHERE n.nspname='public' AND c.relkind IN ('r','p','S','v','m','f') "
            "AND pg_get_userbyid(c.relowner) <> current_user"
        )
        assert not objects, f"Unexpected object owners: {objects}"
        count = await migration.fetchval(
            "SELECT count(*) FROM pg_class c JOIN pg_namespace n "
            "ON n.oid=c.relnamespace "
            "WHERE n.nspname='public' AND c.relkind IN ('r','p')"
        )
        assert count > 1, "Actual application table graph was not created"
        version = await migration.fetchval(
            "SELECT version_num FROM public.alembic_version"
        )
        assert version, "Migration ledger missing"
        await migration.execute(
            "GRANT CONNECT ON DATABASE potapoff_role_ci TO role_ci_runtime"
        )
        await migration.execute(
            "GRANT USAGE ON SCHEMA public TO role_ci_runtime"
        )
        await migration.execute(
            "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public "
            "TO role_ci_runtime"
        )
        await migration.execute(
            "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public "
            "TO role_ci_runtime"
        )
        # Migration history remains readable only by the migration owner
        # (not by the runtime app) even if a future broad DML grant is applied.
        await migration.execute(
            "REVOKE ALL ON TABLE public.alembic_version FROM role_ci_runtime"
        )
    finally:
        await migration.close()

    runtime = await asyncpg.connect(
        host="127.0.0.1", port=55433, database="potapoff_role_ci",
        user="role_ci_runtime", password="ci-role-runtime-only",
    )
    try:
        flags = await runtime.fetchrow(
            "SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, "
            "rolbypassrls FROM pg_roles WHERE rolname=current_user"
        )
        assert flags is not None and not any(flags.values()), flags
        async def denied(query):
            try:
                await runtime.execute(query)
            except asyncpg.InsufficientPrivilegeError:
                return
            raise AssertionError(f"Runtime unexpectedly allowed: {query}")
        await denied("CREATE TABLE public.runtime_must_not_create(id int)")
        await denied(
            "ALTER TABLE public.alembic_version ADD COLUMN runtime_must_not_alter text"
        )
        await denied(
            "UPDATE public.alembic_version SET version_num='tampered'"
        )
        await denied("SET ROLE role_ci_migration")
    finally:
        await runtime.close()
    print("REAL_ALEMBIC_RESTRICTED_ROLE_OK disposable_pg16_only")

asyncio.run(inspect())
PY
