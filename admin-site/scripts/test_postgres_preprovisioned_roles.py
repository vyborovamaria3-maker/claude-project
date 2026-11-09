#!/usr/bin/env python3
"""CI-only, isolated PostgreSQL 17 Admin schema/runtime role regression.

Never touches a live database. Requires the dedicated GitHub Actions fixture
and creates a new temporary database with CI-only non-superuser roles.
"""
from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

import psycopg
from psycopg.errors import InsufficientPrivilege

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
from provision_admin_postgres import provision_roles, provision_schema  # noqa: E402

from app.postgres_admin_state import (  # noqa: E402
    PostgresAuditStore, PostgresControlStore, PostgresLiveAnalysisProfileStore,
)
from app.postgres_schema_policy import (  # noqa: E402
    TABLES, INDEXES, require_admin_postgres_dsn, verify_preprovisioned_schema,
)
from app.postgres_security_store import PostgresAdminSessionStore  # noqa: E402
from app.postgres_task_queue import PostgresTaskQueue  # noqa: E402


FIXTURE = (
    "postgresql://potapoff_admin:ci-admin-state-password"
    "@127.0.0.1:55434/potapoff_admin_test"
)
BOOTSTRAP_ADMIN_DB = (
    "postgresql://potapoff_admin:ci-admin-state-password"
    "@127.0.0.1:55434/admin_roles_ci"
)
MIGRATOR_PASSWORD = "a" * 64
RUNTIME_PASSWORD = "b" * 64
BACKUP_PASSWORD = "c" * 64
MIGRATE = (
    f"postgresql://admin_ci_migration:{MIGRATOR_PASSWORD}"
    "@127.0.0.1:55434/admin_roles_ci"
)
RUNTIME = (
    f"postgresql://admin_ci_runtime:{RUNTIME_PASSWORD}"
    "@127.0.0.1:55434/admin_roles_ci"
)
BACKUP = (
    f"postgresql://admin_ci_backup:{BACKUP_PASSWORD}"
    "@127.0.0.1:55434/admin_roles_ci"
)


def require_ci_only() -> None:
    if (
        os.getenv("GITHUB_ACTIONS") != "true"
        or os.getenv("ADMIN_STATE_TEST_DSN") != FIXTURE
        or os.getenv("ADMIN_PG_SCHEMA_MODE", "legacy") != "legacy"
    ):
        raise SystemExit(
            "Refusing Admin role rehearsal outside the approved isolated CI fixture"
        )


def assert_failed_preflight_did_not_create_roles() -> None:
    with psycopg.connect(BOOTSTRAP_ADMIN_DB) as db:
        remaining = db.execute(
            "SELECT rolname FROM pg_roles WHERE rolname = ANY(%s)",
            (["admin_ci_runtime", "admin_ci_backup"],),
        ).fetchall()
        migrator = db.execute(
            "SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, "
            "rolreplication, rolbypassrls, rolinherit "
            "FROM pg_roles WHERE rolname = 'admin_ci_migration'"
        ).fetchone()
    assert remaining == [], (
        "failed read-only preflight must not create application or backup roles",
        remaining,
    )
    if migrator is not None:
        assert migrator == (False, False, False, False, False, False, False), (
            "failed read-only preflight changed the explicitly prepared migration role",
            migrator,
        )


def provision_test_cluster() -> None:
    with psycopg.connect(FIXTURE, autocommit=True) as db:
        db.execute("CREATE DATABASE admin_roles_ci OWNER potapoff_admin")

    with psycopg.connect(BOOTSTRAP_ADMIN_DB, autocommit=True) as db:
        original_database_owner = db.execute(
            "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()"
        ).fetchone()[0]
        original_schema_owner = db.execute(
            "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='public'"
        ).fetchone()[0]
        assert original_database_owner == "potapoff_admin"
        db.execute(
            "CREATE TYPE public.bootstrap_owned_state AS ENUM ('legacy', 'current')"
        )
        db.execute(
            "CREATE TYPE public.bootstrap_owned_composite AS (payload text)"
        )
        db.execute(
            "CREATE TABLE public.bootstrap_owned_legacy "
            "(id bigint PRIMARY KEY, payload text NOT NULL, state public.bootstrap_owned_state)"
        )
        db.execute("INSERT INTO public.bootstrap_owned_legacy VALUES (1, 'legacy-row', 'legacy')")
        db.execute("CREATE SEQUENCE public.bootstrap_owned_legacy_seq")
        db.execute(
            "CREATE VIEW public.bootstrap_owned_legacy_view "
            "AS SELECT id, payload FROM public.bootstrap_owned_legacy"
        )
        db.execute(
            "CREATE FUNCTION public.bootstrap_owned_legacy_definer() RETURNS bigint "
            "LANGUAGE sql SECURITY DEFINER AS 'SELECT count(*) FROM public.bootstrap_owned_legacy'"
        )
        db.execute(
            "REVOKE ALL ON FUNCTION public.bootstrap_owned_legacy_definer() FROM PUBLIC"
        )

    def provision() -> None:
        provision_roles(
            bootstrap_dsn=BOOTSTRAP_ADMIN_DB,
            app_user="admin_ci_runtime",
            app_password=RUNTIME_PASSWORD,
            migrator_user="admin_ci_migration",
            migrator_password=MIGRATOR_PASSWORD,
            backup_user="admin_ci_backup",
            backup_password=BACKUP_PASSWORD,
        )

    # Existing bootstrap-owned objects must block provisioning. The
    # provisioner must not silently transfer any database/schema/object owner.
    try:
        provision()
    except RuntimeError as exc:
        assert "ownership preflight" in str(exc).lower(), str(exc)
        assert "bootstrap_owned_composite" in str(exc), str(exc)
    else:
        raise AssertionError("Provisioner accepted bootstrap-owned application objects")
    assert_failed_preflight_did_not_create_roles()

    with psycopg.connect(BOOTSTRAP_ADMIN_DB) as bootstrap:
        assert bootstrap.execute(
            "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()"
        ).fetchone()[0] == original_database_owner
        assert bootstrap.execute(
            "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='public'"
        ).fetchone()[0] == original_schema_owner
        owners = dict(
            bootstrap.execute(
                """
                SELECT c.relname, owner_role.rolname
                FROM pg_class c
                JOIN pg_namespace n ON n.oid=c.relnamespace
                JOIN pg_roles owner_role ON owner_role.oid=c.relowner
                WHERE n.nspname='public'
                  AND c.relname IN (
                    'bootstrap_owned_legacy',
                    'bootstrap_owned_legacy_seq',
                    'bootstrap_owned_legacy_view'
                  )
                """
            ).fetchall()
        )
        assert set(owners.values()) == {"potapoff_admin"}, owners

        # The migration identity is created explicitly by the isolated test
        # allowlist step; production provisioning must not create or mutate it
        # before every existing object owner has passed preflight.
        bootstrap.execute("CREATE ROLE admin_ci_migration NOLOGIN NOINHERIT")
        bootstrap.execute(
            "GRANT CREATE ON SCHEMA public TO admin_ci_migration"
        )

        # This is the explicit, test-only object allowlist rehearsal. Production
        # provisioning never performs these ALTER OWNER statements automatically.
        bootstrap.execute(
            "ALTER TABLE public.bootstrap_owned_legacy OWNER TO admin_ci_migration"
        )
        bootstrap.execute(
            "ALTER SEQUENCE public.bootstrap_owned_legacy_seq OWNER TO admin_ci_migration"
        )
        bootstrap.execute(
            "ALTER VIEW public.bootstrap_owned_legacy_view OWNER TO admin_ci_migration"
        )
        bootstrap.execute(
            "ALTER FUNCTION public.bootstrap_owned_legacy_definer() OWNER TO admin_ci_migration"
        )
        bootstrap.execute(
            "ALTER TYPE public.bootstrap_owned_state OWNER TO admin_ci_migration"
        )
        bootstrap.execute(
            "GRANT EXECUTE ON FUNCTION public.bootstrap_owned_legacy_definer() TO PUBLIC"
        )

    # The standalone composite type remains bootstrap-owned after the explicit
    # allowlist above; provisioning must continue to fail closed on that type.
    try:
        provision()
    except RuntimeError as exc:
        assert "ownership preflight" in str(exc).lower(), str(exc)
        assert "bootstrap_owned_composite" in str(exc), str(exc)
    else:
        raise AssertionError("Provisioner accepted a bootstrap-owned composite type")
    assert_failed_preflight_did_not_create_roles()

    with psycopg.connect(BOOTSTRAP_ADMIN_DB) as bootstrap:
        bootstrap.execute(
            "ALTER TYPE public.bootstrap_owned_composite OWNER TO admin_ci_migration"
        )

    # Even after owners are prepared, PUBLIC execution of a SECURITY DEFINER
    # routine is an independent blocker.
    try:
        provision()
    except RuntimeError as exc:
        assert "security definer" in str(exc).lower(), str(exc)
    else:
        raise AssertionError("Provisioner accepted a PUBLIC-executable SECURITY DEFINER function")
    assert_failed_preflight_did_not_create_roles()

    with psycopg.connect(BOOTSTRAP_ADMIN_DB) as bootstrap:
        bootstrap.execute(
            "REVOKE ALL ON FUNCTION public.bootstrap_owned_legacy_definer() FROM PUBLIC"
        )

    provision()

    with psycopg.connect(BOOTSTRAP_ADMIN_DB) as bootstrap:
        database_owner = bootstrap.execute(
            "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()"
        ).fetchone()[0]
        schema_owner = bootstrap.execute(
            "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='public'"
        ).fetchone()[0]
        assert database_owner == original_database_owner, database_owner
        assert schema_owner == original_schema_owner, schema_owner

    with psycopg.connect(MIGRATE) as db:
        owners = dict(
            db.execute(
                """
                SELECT c.relname, owner_role.rolname
                FROM pg_class c
                JOIN pg_namespace n ON n.oid=c.relnamespace
                JOIN pg_roles owner_role ON owner_role.oid=c.relowner
                WHERE n.nspname='public'
                  AND c.relname IN (
                    'bootstrap_owned_legacy',
                    'bootstrap_owned_legacy_seq',
                    'bootstrap_owned_legacy_view'
                  )
                """
            ).fetchall()
        )
        function_owner = db.execute(
            """
            SELECT pg_get_userbyid(proowner)
            FROM pg_proc
            WHERE oid='public.bootstrap_owned_legacy_definer()'::regprocedure
            """
        ).fetchone()[0]
        type_owner = db.execute(
            """
            SELECT pg_get_userbyid(typowner)
            FROM pg_type
            WHERE oid='public.bootstrap_owned_state'::regtype
            """
        ).fetchone()[0]
        composite_type_owner = db.execute(
            """
            SELECT pg_get_userbyid(typowner)
            FROM pg_type
            WHERE oid='public.bootstrap_owned_composite'::regtype
            """
        ).fetchone()[0]
    assert set(owners.values()) == {"admin_ci_migration"}, owners
    assert function_owner == "admin_ci_migration", function_owner
    assert type_owner == "admin_ci_migration", type_owner
    assert composite_type_owner == "admin_ci_migration", composite_type_owner

    with psycopg.connect(BACKUP) as db:
        flags = db.execute(
            "SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls "
            "FROM pg_roles WHERE rolname=current_user"
        ).fetchone()
        assert flags == (False, False, False, False, False), flags
        assert db.execute(
            "SELECT pg_has_role(current_user, 'pg_read_all_data', 'MEMBER')"
        ).fetchone()[0] is False
        assert db.execute(
            "SELECT has_database_privilege(current_user,current_database(),'CREATE'), "
            "has_schema_privilege(current_user,'public','CREATE')"
        ).fetchone() == (False, False)
        assert db.execute("SHOW default_transaction_read_only").fetchone()[0] == "on"
        assert db.execute(
            "SELECT payload FROM public.bootstrap_owned_legacy WHERE id=1"
        ).fetchone()[0] == "legacy-row"
        db.execute("SET default_transaction_read_only=off")
        try:
            with db.transaction():
                db.execute(
                    "UPDATE public.bootstrap_owned_legacy SET payload='backup-must-not-write'"
                )
        except InsufficientPrivilege:
            pass
        else:
            raise AssertionError("Admin backup role unexpectedly wrote application data")


def schema_objects(dsn: str) -> tuple[tuple[str, str, str], ...]:
    with psycopg.connect(dsn) as db:
        rows = db.execute(
            "SELECT n.nspname, c.relname, c.relkind "
            "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
            "WHERE n.nspname='public' "
            "ORDER BY n.nspname, c.relname, c.relkind"
        ).fetchall()
        return tuple(rows)


def bootstrap_schema_under_migration_owner() -> None:
    # This is the same DDL + ACL path used before the production Admin API starts.
    provision_schema(
        migrator_dsn=MIGRATE,
        runtime_dsn=RUNTIME,
        app_user="admin_ci_runtime",
        migrator_user="admin_ci_migration",
        backup_user="admin_ci_backup",
    )
    with psycopg.connect(BACKUP) as db:
        assert db.execute("SELECT count(*) FROM public.admin_audit").fetchone()[0] == 0
        db.execute("SET default_transaction_read_only=off")
        try:
            with db.transaction():
                db.execute("DELETE FROM public.admin_audit")
        except InsufficientPrivilege:
            pass
        else:
            raise AssertionError("Admin backup role unexpectedly deleted audit rows")


def assert_runtime_restricted() -> None:
    with psycopg.connect(RUNTIME) as db:
        for bad_sql in (
            "CREATE TABLE public.forbidden_runtime_table(id int)",
            "ALTER TABLE public.feature_flags ADD COLUMN forbidden_runtime_column text",
            "UPDATE public.admin_audit SET action='tampered'",
            "DELETE FROM public.admin_audit",
            "CREATE ROLE forbidden_admin_role LOGIN",
        ):
            try:
                with db.transaction():
                    db.execute(bad_sql)
            except InsufficientPrivilege:
                pass
            else:
                raise AssertionError(f"Restricted runtime unexpectedly accepted {bad_sql}")

    os.environ["ADMIN_PG_SCHEMA_MODE"] = "preprovisioned"
    verify_preprovisioned_schema(RUNTIME)

    # Runtime startup must reject a SECURITY DEFINER routine that remains
    # executable by PUBLIC, even if the rest of the schema ACLs are correct.
    with psycopg.connect(BOOTSTRAP_ADMIN_DB) as bootstrap:
        bootstrap.execute(
            "CREATE FUNCTION public.admin_ci_public_definer() RETURNS integer "
            "LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'"
        )
    try:
        try:
            verify_preprovisioned_schema(RUNTIME)
        except RuntimeError as exc:
            assert "security definer" in str(exc).lower(), str(exc)
        else:
            raise AssertionError("PUBLIC-executable SECURITY DEFINER function was accepted")
    finally:
        with psycopg.connect(BOOTSTRAP_ADMIN_DB) as bootstrap:
            bootstrap.execute("DROP FUNCTION public.admin_ci_public_definer()")
    verify_preprovisioned_schema(RUNTIME)

    # Migrator-created functions must not inherit PostgreSQL's default PUBLIC EXECUTE.
    with psycopg.connect(MIGRATE) as migration:
        migration.execute(
            "CREATE FUNCTION public.admin_ci_private_function() RETURNS integer "
            "LANGUAGE sql AS 'SELECT 7'"
        )
        public_execute = migration.execute(
            "SELECT EXISTS ("
            "SELECT 1 FROM pg_proc p "
            "CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f',p.proowner))) acl "
            "WHERE p.oid='public.admin_ci_private_function()'::regprocedure "
            "AND acl.grantee=0 AND acl.privilege_type='EXECUTE')"
        ).fetchone()[0]
        assert public_execute is False, "Migrator-created function retained PUBLIC EXECUTE"
    for restricted_dsn in (RUNTIME, BACKUP):
        with psycopg.connect(restricted_dsn) as restricted:
            try:
                restricted.execute("SELECT public.admin_ci_private_function()")
            except InsufficientPrivilege:
                pass
            else:
                raise AssertionError("Restricted identity executed an ungranted function")
    with psycopg.connect(MIGRATE) as migration:
        migration.execute("DROP FUNCTION public.admin_ci_private_function()")
    verify_preprovisioned_schema(RUNTIME)

    # Membership in a table-owner role must be rejected even when that role
    # has no schema CREATE grant. This exercises the object-owner check rather
    # than the separate SET-reachable schema privilege gate.
    with psycopg.connect(BOOTSTRAP_ADMIN_DB) as bootstrap:
        bootstrap.execute("CREATE ROLE admin_ci_table_owner NOLOGIN")
        bootstrap.execute("GRANT CREATE ON SCHEMA public TO admin_ci_table_owner")
        bootstrap.execute("ALTER TABLE public.feature_flags OWNER TO admin_ci_table_owner")
        bootstrap.execute("REVOKE CREATE ON SCHEMA public FROM admin_ci_table_owner")
        bootstrap.execute(
            "GRANT admin_ci_table_owner TO admin_ci_runtime "
            "WITH INHERIT FALSE, SET TRUE"
        )
    try:
        try:
            verify_preprovisioned_schema(RUNTIME)
        except RuntimeError as exc:
            assert "ownership/rls gate failed for feature_flags" in str(exc).lower(), str(exc)
        else:
            raise AssertionError("SET-able table-owner membership was accepted")
    finally:
        with psycopg.connect(BOOTSTRAP_ADMIN_DB) as bootstrap:
            bootstrap.execute("REVOKE admin_ci_table_owner FROM admin_ci_runtime")
            bootstrap.execute("ALTER TABLE public.feature_flags OWNER TO admin_ci_migration")
            bootstrap.execute("DROP ROLE admin_ci_table_owner")
    verify_preprovisioned_schema(RUNTIME)

    # A mistaken audit UPDATE grant must fail startup verification as well.
    with psycopg.connect(MIGRATE) as db:
        db.execute("GRANT UPDATE ON TABLE public.admin_audit TO admin_ci_runtime")
    try:
        verify_preprovisioned_schema(RUNTIME)
    except RuntimeError as exc:
        assert "append-only" in str(exc).lower(), str(exc)
    else:
        raise AssertionError("Writable audit history unexpectedly accepted")
    finally:
        with psycopg.connect(MIGRATE) as db:
            db.execute("REVOKE UPDATE ON TABLE public.admin_audit FROM admin_ci_runtime")
    verify_preprovisioned_schema(RUNTIME)

    # UPDATE(column) does not require table-wide UPDATE and still changes
    # audit history. Verify the fail-closed gate detects column-level ACLs.
    with psycopg.connect(MIGRATE) as db:
        db.execute("GRANT UPDATE(action) ON public.admin_audit TO admin_ci_runtime")
    try:
        verify_preprovisioned_schema(RUNTIME)
    except RuntimeError as exc:
        assert "append-only" in str(exc).lower(), str(exc)
    else:
        raise AssertionError("Column-level audit UPDATE unexpectedly accepted")
    finally:
        with psycopg.connect(MIGRATE) as db:
            db.execute("REVOKE UPDATE(action) ON public.admin_audit FROM admin_ci_runtime")
    verify_preprovisioned_schema(RUNTIME)

    # UPDATE/DELETE on audit history are insufficient for immutability:
    # TRUNCATE can erase the entire audit log without either privilege.
    with psycopg.connect(MIGRATE) as db:
        db.execute("GRANT TRUNCATE ON public.admin_audit TO admin_ci_runtime")
    try:
        verify_preprovisioned_schema(RUNTIME)
    except RuntimeError as exc:
        assert "unsafe table privileges" in str(exc).lower(), str(exc)
    else:
        raise AssertionError("TRUNCATE on immutable audit history was accepted")
    finally:
        with psycopg.connect(MIGRATE) as db:
            db.execute("REVOKE TRUNCATE ON public.admin_audit FROM admin_ci_runtime")
    verify_preprovisioned_schema(RUNTIME)

    # An application runtime must not be able to create databases/schemas
    # or temporary objects via the database-level ACL.
    with psycopg.connect(MIGRATE) as db:
        db.execute("GRANT CREATE, TEMPORARY ON DATABASE admin_roles_ci TO admin_ci_runtime")
    try:
        verify_preprovisioned_schema(RUNTIME)
    except RuntimeError as exc:
        assert (
            "database-level" in str(exc).lower()
            or "set-reachable database ddl" in str(exc).lower()
        ), str(exc)
    else:
        raise AssertionError("Database CREATE/TEMP rights were accepted")
    finally:
        with psycopg.connect(MIGRATE) as db:
            db.execute("REVOKE CREATE, TEMPORARY ON DATABASE admin_roles_ci FROM admin_ci_runtime")
    verify_preprovisioned_schema(RUNTIME)

    # USAGE lets nextval() work. UPDATE would additionally let the app
    # setval() and tamper with allocated identifiers.
    with psycopg.connect(MIGRATE) as db:
        db.execute("GRANT UPDATE ON SEQUENCE public.admin_audit_id_seq TO admin_ci_runtime")
    try:
        verify_preprovisioned_schema(RUNTIME)
    except RuntimeError as exc:
        assert "sequence" in str(exc).lower(), str(exc)
    else:
        raise AssertionError("Sequence UPDATE privilege was accepted")
    finally:
        with psycopg.connect(MIGRATE) as db:
            db.execute("REVOKE UPDATE ON SEQUENCE public.admin_audit_id_seq FROM admin_ci_runtime")
    verify_preprovisioned_schema(RUNTIME)

    # Dangerous predefined memberships are not visible in the role's
    # NOSUPERUSER flags; do not let a runtime login SET ROLE into one.
    with psycopg.connect(BOOTSTRAP_ADMIN_DB) as bootstrap:
        bootstrap.execute(
            "GRANT pg_execute_server_program TO admin_ci_runtime "
            "WITH INHERIT FALSE, SET TRUE"
        )
    try:
        try:
            verify_preprovisioned_schema(RUNTIME)
        except RuntimeError as exc:
            assert "predefined-role membership" in str(exc).lower(), str(exc)
        else:
            raise AssertionError("Dangerous PostgreSQL predefined-role membership was accepted")
    finally:
        with psycopg.connect(BOOTSTRAP_ADMIN_DB) as bootstrap:
            bootstrap.execute("REVOKE pg_execute_server_program FROM admin_ci_runtime")
    verify_preprovisioned_schema(RUNTIME)

    # Custom role attributes are also dangerous through SET ROLE even
    # when the role owns no application schema or table.
    with psycopg.connect(BOOTSTRAP_ADMIN_DB) as bootstrap:
        bootstrap.execute("CREATE ROLE admin_ci_privileged_helper NOLOGIN CREATEROLE")
        bootstrap.execute(
            "GRANT admin_ci_privileged_helper TO admin_ci_runtime "
            "WITH INHERIT FALSE, SET TRUE"
        )
    try:
        with psycopg.connect(RUNTIME) as db:
            db.execute("SET ROLE admin_ci_privileged_helper")
            assert db.execute("SELECT current_user").fetchone()[0] == "admin_ci_privileged_helper"
        try:
            verify_preprovisioned_schema(RUNTIME)
        except RuntimeError as exc:
            assert "SET-reachable privileged role attributes" in str(exc), str(exc)
        else:
            raise AssertionError("SET-only CREATEROLE membership was accepted")
    finally:
        with psycopg.connect(BOOTSTRAP_ADMIN_DB) as bootstrap:
            bootstrap.execute("REVOKE admin_ci_privileged_helper FROM admin_ci_runtime")
            bootstrap.execute("DROP ROLE admin_ci_privileged_helper")
    verify_preprovisioned_schema(RUNTIME)

    # A runtime account can be a non-INHERITING member of the schema-owner
    # role while retaining SET ROLE. Such an account can still become the
    # migration owner for DDL; startup verification must fail closed.
    with psycopg.connect(BOOTSTRAP_ADMIN_DB) as bootstrap:
        bootstrap.execute(
            "GRANT admin_ci_migration TO admin_ci_runtime "
            "WITH INHERIT FALSE, SET TRUE"
        )
    try:
        with psycopg.connect(RUNTIME) as db:
            assert db.execute(
                "SELECT has_schema_privilege(current_user, 'public', 'CREATE')"
            ).fetchone()[0] is False
            db.execute("SET ROLE admin_ci_migration")
            assert db.execute("SELECT current_user").fetchone()[0] == "admin_ci_migration"
        try:
            verify_preprovisioned_schema(RUNTIME)
        except RuntimeError as exc:
            # The migration identity owns both the fixture database and
            # application tables; either early gate must reject SET ROLE.
            assert (
                "ownership" in str(exc).lower()
                or "database-level" in str(exc).lower()
                or "set-reachable database ddl" in str(exc).lower()
                or "ddl privileges in schema: public" in str(exc).lower()
            ), str(exc)
        else:
            raise AssertionError("SET-only migration-role membership was not rejected")
    finally:
        with psycopg.connect(BOOTSTRAP_ADMIN_DB) as bootstrap:
            bootstrap.execute("REVOKE admin_ci_migration FROM admin_ci_runtime")
    verify_preprovisioned_schema(RUNTIME)

    before = schema_objects(MIGRATE)
    audit = PostgresAuditStore(RUNTIME)
    control = PostgresControlStore(RUNTIME)
    PostgresLiveAnalysisProfileStore(RUNTIME)
    queue = PostgresTaskQueue(RUNTIME, workers=1)
    security = PostgresAdminSessionStore(
        RUNTIME, ip_binding=lambda _: "", ua_binding=lambda _: ""
    )
    after = schema_objects(MIGRATE)
    assert before == after, "Admin startup changed the schema in DML-only mode"
    audit.record(action="role_rehearsal", success=True, username="ci")
    control.set_flag("role.rehearsal", True, "ci fixture", "ci")
    assert any(x["name"] == "role.rehearsal" for x in control.flags())
    assert queue.metrics()["queued"] == 0
    assert security.is_revoked("nonexistent") is False

    # A failed permission preflight must not quietly fall back to DDL.
    with psycopg.connect(MIGRATE) as db:
        db.execute("REVOKE SELECT ON TABLE public.feature_flags FROM admin_ci_runtime")
    try:
        verify_preprovisioned_schema(RUNTIME)
    except RuntimeError as exc:
        assert "privilege" in str(exc).lower(), str(exc)
    else:
        raise AssertionError("Missing runtime SELECT was not rejected")
    with psycopg.connect(MIGRATE) as db:
        db.execute("GRANT SELECT ON TABLE public.feature_flags TO admin_ci_runtime")

    with psycopg.connect(MIGRATE) as db:
        db.execute("DROP INDEX public.ix_admin_tasks_owner_created")
    try:
        verify_preprovisioned_schema(RUNTIME)
    except RuntimeError as exc:
        assert "index" in str(exc).lower(), str(exc)
    else:
        raise AssertionError("Missing Admin index was not rejected")
    with psycopg.connect(MIGRATE) as db:
        db.execute(
            "CREATE INDEX ix_admin_tasks_owner_created "
            "ON public.admin_background_tasks(owner, created_at DESC)"
        )
    verify_preprovisioned_schema(RUNTIME)

    # A fake index with the expected name but WRONG target table/keys is
    # not proof that the restored schema can serve live Admin queries.
    with psycopg.connect(MIGRATE) as db:
        db.execute("DROP INDEX public.ix_admin_tasks_owner_created")
        db.execute(
            "CREATE INDEX ix_admin_tasks_owner_created "
            "ON public.feature_flags(name)"
        )
    try:
        verify_preprovisioned_schema(RUNTIME)
    except RuntimeError as exc:
        assert "index definition" in str(exc).lower(), str(exc)
    else:
        raise AssertionError("Same-name wrong-table index was accepted")
    finally:
        with psycopg.connect(MIGRATE) as db:
            db.execute("DROP INDEX public.ix_admin_tasks_owner_created")
            db.execute(
                "CREATE INDEX ix_admin_tasks_owner_created "
                "ON public.admin_background_tasks(owner, created_at DESC)"
            )
    verify_preprovisioned_schema(RUNTIME)

    # A repaired index must not hide a column type drift or missing PK.
    with psycopg.connect(MIGRATE) as db:
        db.execute("ALTER TABLE public.feature_flags ALTER COLUMN description TYPE varchar(500)")
    try:
        verify_preprovisioned_schema(RUNTIME)
    except RuntimeError as exc:
        assert "column contract" in str(exc).lower(), str(exc)
    else:
        raise AssertionError("Column type drift was accepted")
    finally:
        with psycopg.connect(MIGRATE) as db:
            db.execute("ALTER TABLE public.feature_flags ALTER COLUMN description TYPE text")
    verify_preprovisioned_schema(RUNTIME)

    with psycopg.connect(MIGRATE) as db:
        db.execute("ALTER TABLE public.feature_flags DROP CONSTRAINT feature_flags_pkey")
    try:
        verify_preprovisioned_schema(RUNTIME)
    except RuntimeError as exc:
        assert "primary-key" in str(exc).lower(), str(exc)
    else:
        raise AssertionError("Missing Admin primary key was accepted")
    finally:
        with psycopg.connect(MIGRATE) as db:
            db.execute("ALTER TABLE public.feature_flags ADD PRIMARY KEY (name)")
    verify_preprovisioned_schema(RUNTIME)

    # Defaults matter to inserts, even when the table/column types pass.
    with psycopg.connect(MIGRATE) as db:
        db.execute("ALTER TABLE public.feature_flags ALTER COLUMN enabled DROP DEFAULT")
    try:
        verify_preprovisioned_schema(RUNTIME)
    except RuntimeError as exc:
        assert "default contract" in str(exc).lower(), str(exc)
    else:
        raise AssertionError("Missing Admin default was accepted")
    finally:
        with psycopg.connect(MIGRATE) as db:
            db.execute("ALTER TABLE public.feature_flags ALTER COLUMN enabled SET DEFAULT FALSE")
    verify_preprovisioned_schema(RUNTIME)

    # A constraint added outside the reviewed migration could reject writes.
    with psycopg.connect(MIGRATE) as db:
        db.execute(
            "ALTER TABLE public.feature_flags "
            "ADD CONSTRAINT suspicious_ci_check CHECK (char_length(name) < 5) NOT VALID"
        )
    try:
        verify_preprovisioned_schema(RUNTIME)
    except RuntimeError as exc:
        assert "unexpected constraint" in str(exc).lower(), str(exc)
    else:
        raise AssertionError("Unreviewed Admin CHECK constraint was accepted")
    finally:
        with psycopg.connect(MIGRATE) as db:
            db.execute("ALTER TABLE public.feature_flags DROP CONSTRAINT suspicious_ci_check")
    verify_preprovisioned_schema(RUNTIME)

    # Role granted CREATE on an *auxiliary* schema is not DML-only, even
    # when public schema and database-level CREATE are denied.
    with psycopg.connect(MIGRATE) as db:
        db.execute("CREATE SCHEMA auxiliary_ci")
        db.execute("GRANT CREATE ON SCHEMA auxiliary_ci TO admin_ci_runtime")
    try:
        verify_preprovisioned_schema(RUNTIME)
    except RuntimeError as exc:
        assert "schema: auxiliary_ci" in str(exc).lower(), str(exc)
    else:
        raise AssertionError("Auxiliary schema CREATE was accepted")
    finally:
        with psycopg.connect(MIGRATE) as db:
            db.execute("DROP SCHEMA auxiliary_ci CASCADE")
    verify_preprovisioned_schema(RUNTIME)

    # SET-able helper role has CREATE, while the runtime login itself does
    # not and neither role owns the application tables. Owner-only scans miss
    # this precise privilege escalation through SET ROLE.
    with psycopg.connect(BOOTSTRAP_ADMIN_DB) as bootstrap:
        bootstrap.execute("CREATE ROLE admin_ci_ddl_helper NOLOGIN")
        bootstrap.execute(
            "GRANT admin_ci_ddl_helper TO admin_ci_runtime "
            "WITH INHERIT FALSE, SET TRUE"
        )
    with psycopg.connect(MIGRATE) as db:
        db.execute("GRANT CREATE ON SCHEMA public TO admin_ci_ddl_helper")
    try:
        with psycopg.connect(RUNTIME) as db:
            assert db.execute(
                "SELECT has_schema_privilege(current_user, 'public', 'CREATE')"
            ).fetchone()[0] is False
            db.execute("SET ROLE admin_ci_ddl_helper")
            assert db.execute(
                "SELECT has_schema_privilege(current_user, 'public', 'CREATE')"
            ).fetchone()[0] is True
        try:
            verify_preprovisioned_schema(RUNTIME)
        except RuntimeError as exc:
            assert "SET-reachable schema DDL" in str(exc), str(exc)
        else:
            raise AssertionError("SET-only helper CREATE grant was accepted")
    finally:
        with psycopg.connect(MIGRATE) as db:
            db.execute("REVOKE CREATE ON SCHEMA public FROM admin_ci_ddl_helper")
        with psycopg.connect(BOOTSTRAP_ADMIN_DB) as bootstrap:
            bootstrap.execute("REVOKE admin_ci_ddl_helper FROM admin_ci_runtime")
            bootstrap.execute("DROP ROLE admin_ci_ddl_helper")
    verify_preprovisioned_schema(RUNTIME)

    print("ADMIN_PG_PREPROVISIONED_RUNTIME_OK disposable_pg17_only")


def assert_sqlite_state_migration_uses_migrator() -> None:
    """The deploy cutover must use the DDL-capable migrator, never the runtime login."""
    marker = "migration_ci_" + uuid.uuid4().hex
    nonce = "revoked_ci_" + uuid.uuid4().hex
    with tempfile.TemporaryDirectory(prefix="admin-state-migration-") as tmp:
        sqlite_path = Path(tmp) / "audit.db"
        with sqlite3.connect(sqlite_path) as source:
            source.executescript(
                """
                CREATE TABLE admin_audit(
                    id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, username TEXT,
                    ip_address TEXT, action TEXT NOT NULL, resource TEXT,
                    success INTEGER NOT NULL, details_json TEXT
                );
                CREATE TABLE alerts(
                    id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL,
                    title TEXT NOT NULL, message TEXT NOT NULL, source TEXT NOT NULL,
                    status TEXT NOT NULL, created_at TEXT NOT NULL,
                    acknowledged_at TEXT, acknowledged_by TEXT
                );
                CREATE TABLE revoked_admin_sessions(
                    nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL,
                    revoked_at TEXT NOT NULL
                );
                """
            )
            source.execute(
                "INSERT INTO admin_audit VALUES(41,?,?,?,?,?,?,?)",
                ("2026-11-09T00:00:00+00:00", "admin", "127.0.0.1", marker, None, 1, '{"source":"ci"}'),
            )
            source.execute(
                "INSERT INTO alerts VALUES(7,'warning',?,'migration fixture','ci','open',?,NULL,NULL)",
                (marker, "2026-11-09T00:00:00+00:00"),
            )
            source.execute(
                "INSERT INTO revoked_admin_sessions VALUES(?,?,?)",
                (nonce, 2_000_000_000, "2026-11-09T00:00:00+00:00"),
            )

        with psycopg.connect(MIGRATE) as db:
            assert db.execute(
                "SELECT to_regclass('public.admin_state_migrations')"
            ).fetchone()[0] is None, "migration marker must be created by the migrator"

        env = os.environ.copy()
        env.update(
            {
                "ADMIN_PG_SCHEMA_MODE": "preprovisioned",
                "ADMIN_STATE_MIGRATOR_DSN": MIGRATE,
                # Deliberately provide the runtime DSN too. The script must
                # select the migrator DSN because it creates DDL and calls setval.
                "ADMIN_STATE_POSTGRES_DSN": RUNTIME,
                "ADMIN_AUDIT_DB": str(sqlite_path),
            }
        )
        script = ROOT / "scripts" / "migrate_admin_state_to_postgres.py"
        command = [sys.executable, str(script)]
        first = subprocess.run(
            command, cwd=ROOT, env=env, capture_output=True, text=True, check=True
        )
        assert "MIGRATION_OK already_applied=false" in first.stdout, first.stdout

        second_marker = marker + "_second"
        second_nonce = "revoked_ci_" + uuid.uuid4().hex
        with sqlite3.connect(sqlite_path) as source:
            source.execute(
                "INSERT INTO admin_audit VALUES(42,?,?,?,?,?,?,?)",
                ("2026-11-09T00:01:00+00:00", "admin", "127.0.0.1", second_marker, None, 1, '{"source":"ci-second"}'),
            )
            source.execute(
                "INSERT INTO revoked_admin_sessions VALUES(?,?,?)",
                (second_nonce, 2_000_000_000, "2026-11-09T00:01:00+00:00"),
            )

        second = subprocess.run(
            command, cwd=ROOT, env=env, capture_output=True, text=True, check=True
        )
        assert "SKIP admin-sqlite-to-postgres-v1: source fingerprint unchanged" in second.stdout

        second_marker = marker + "_second"
        second_nonce = "revoked_ci_" + uuid.uuid4().hex
        with sqlite3.connect(sqlite_path) as source:
            source.execute(
                "INSERT INTO admin_audit VALUES(42,?,?,?,?,?,?,?)",
                ("2026-11-09T00:01:00+00:00", "admin", "127.0.0.1", second_marker, None, 1, '{"source":"ci-second"}'),
            )
            source.execute(
                "INSERT INTO revoked_admin_sessions VALUES(?,?,?)",
                (second_nonce, 2_000_000_000, "2026-11-09T00:01:00+00:00"),
            )

        changed = subprocess.run(
            command, cwd=ROOT, env=env, capture_output=True, text=True
        )
        assert changed.returncode != 0, changed.stdout
        assert "SQLite admin state changed after PostgreSQL cutover" in changed.stderr

    with psycopg.connect(RUNTIME) as db:
        assert db.execute(
            "SELECT 1 FROM admin_audit WHERE action=%s", (marker,)
        ).fetchone() is not None
        assert db.execute(
            "SELECT 1 FROM alerts WHERE title=%s", (marker,)
        ).fetchone() is not None
        assert db.execute(
            "SELECT 1 FROM revoked_admin_sessions WHERE nonce=%s", (nonce,)
        ).fetchone() is not None
        assert db.execute(
            "SELECT 1 FROM admin_audit WHERE action=%s", (second_marker,)
        ).fetchone() is None
        assert db.execute(
            "SELECT 1 FROM revoked_admin_sessions WHERE nonce=%s", (second_nonce,)
        ).fetchone() is None
        assert db.execute(
            "SELECT 1 FROM admin_state_migrations "
            "WHERE migration_key='admin-sqlite-to-postgres-v1'"
        ).fetchone() is not None

    print("ADMIN_SQLITE_STATE_MIGRATION_OK dedicated_migrator=true runtime_dml_only=true")


def assert_full_admin_app_smoke() -> None:
    """The actual FastAPI app and its background-worker lifespan must start."""
    import json
    import tempfile
    from fastapi.testclient import TestClient

    with tempfile.TemporaryDirectory(prefix="admin-role-e2e-") as tmp:
        base = Path(tmp)
        (base / "sources.json").write_text("[]", encoding="utf-8")
        (base / "logs.json").write_text("[]", encoding="utf-8")
        env_overrides = {
            "ADMIN_PG_SCHEMA_MODE": "preprovisioned",
            "ADMIN_STATE_POSTGRES_DSN": RUNTIME,
            "ADMIN_ENVIRONMENT": "test",
            "ADMIN_SESSION_SECRET": "ci-test-session-secret-" + "x" * 40,
            "ADMIN_USERNAME": "admin",
            "ADMIN_PASSWORD": "ci-only-test-password",
            "ADMIN_PASSWORD_HASH": "",
            "ADMIN_SECURE_COOKIE": "false",
            "ADMIN_AUDIT_DB": str(base / "audit.db"),
            "ADMIN_SOURCES_FILE": str(base / "sources.json"),
            "ADMIN_LOGS_FILE": str(base / "logs.json"),
            "ADMIN_INTELLIGENCE_BACKEND": "sqlite",
            "ADMIN_INTELLIGENCE_DB": str(base / "intelligence.db"),
            "ADMIN_ALLOWED_NETWORKS": "",
            "ADMIN_ALLOWED_ORIGINS": "",
            "ADMIN_REQUIRE_NETWORK_ALLOWLIST": "false",
        }
        original = {key: os.environ.get(key) for key in env_overrides}
        os.environ.update(env_overrides)
        try:
            # Module-level app construction is intentional: production imports
            # app.main_admin:app, rather than instantiating stores directly.
            from app import main_admin

            app = main_admin.app
            with TestClient(app) as client:
                health = client.get("/api/health")
                assert health.status_code == 200, health.text
                ready = client.get("/api/ready")
                assert ready.status_code == 200, ready.text
                payload = ready.json()
                assert payload["ready"] is True, payload
                assert payload["task_backend"] == "postgres", payload
                assert payload["mutable_state_backend"] == "postgres", payload
                assert payload["security_backend"] == "postgres", payload
                login = client.post(
                    "/api/login",
                    json={"username": "admin", "password": "ci-only-test-password"},
                )
                assert login.status_code == 200, login.text
                flag = client.put(
                    "/api/feature-flags/review.smoke",
                    json={
                        "name": "review.smoke",
                        "enabled": True,
                        "description": "restricted-PG17-FastAPI-fixture",
                    },
                )
                assert flag.status_code == 200, flag.text
                flags = client.get("/api/feature-flags")
                assert flags.status_code == 200, flags.text
                assert any(
                    entry["name"] == "review.smoke" and entry["enabled"]
                    for entry in flags.json()["rows"]
                ), flags.text
                queue = app.state.task_queue
                assert queue.metrics()["workers_alive"] == queue._workers_count
            print("ADMIN_PG_FULL_FASTAPI_APP_OK restricted_pg17_api_ready_login_write")
        finally:
            for key, value in original.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value


def main() -> None:
    require_ci_only()
    # Fail closed before creating the Admin app: requested PostgreSQL runtime
    # mode must not fall back to local SQLite on an omitted/blank DSN.
    os.environ["ADMIN_PG_SCHEMA_MODE"] = "preprovisioned"
    for missing in ("", "   "):
        try:
            require_admin_postgres_dsn(missing)
        except RuntimeError as exc:
            assert "ADMIN_STATE_POSTGRES_DSN" in str(exc), str(exc)
        else:
            raise AssertionError("Preprovisioned mode accepted missing PostgreSQL DSN")
    require_admin_postgres_dsn(RUNTIME)
    os.environ["ADMIN_PG_SCHEMA_MODE"] = "legacy"
    require_admin_postgres_dsn("")
    provision_test_cluster()
    os.environ["ADMIN_PG_SCHEMA_MODE"] = "preprovisioned"
    try:
        verify_preprovisioned_schema(RUNTIME)
    except RuntimeError as exc:
        assert "missing required tables" in str(exc).lower(), str(exc)
    else:
        raise AssertionError("Empty schema was not rejected")
    bootstrap_schema_under_migration_owner()
    assert_runtime_restricted()
    assert_sqlite_state_migration_uses_migrator()
    assert_full_admin_app_smoke()


if __name__ == "__main__":
    main()
