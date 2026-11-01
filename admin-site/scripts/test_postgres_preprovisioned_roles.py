#!/usr/bin/env python3
"""CI-only, isolated PostgreSQL 17 Admin schema/runtime role regression.

Never touches a live database. Requires the dedicated GitHub Actions fixture
and creates a new temporary database with CI-only non-superuser roles.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import psycopg
from psycopg.errors import InsufficientPrivilege

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.postgres_admin_state import (  # noqa: E402
    PostgresAuditStore, PostgresControlStore, PostgresLiveAnalysisProfileStore,
)
from app.postgres_schema_policy import (  # noqa: E402
    TABLES, INDEXES, verify_preprovisioned_schema,
)
from app.postgres_security_store import PostgresAdminSessionStore  # noqa: E402
from app.postgres_task_queue import PostgresTaskQueue  # noqa: E402


FIXTURE = (
    "postgresql://potapoff_admin:ci-admin-state-password"
    "@127.0.0.1:55434/potapoff_admin_test"
)
MIGRATE = (
    "postgresql://admin_ci_migration:ci-admin-migration-password"
    "@127.0.0.1:55434/admin_roles_ci"
)
RUNTIME = (
    "postgresql://admin_ci_runtime:ci-admin-runtime-password"
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


def provision_test_cluster() -> None:
    with psycopg.connect(FIXTURE, autocommit=True) as db:
        for sql in (
            "CREATE ROLE admin_ci_migration LOGIN NOSUPERUSER NOCREATEDB "
            "NOCREATEROLE NOREPLICATION NOBYPASSRLS "
            "PASSWORD 'ci-admin-migration-password'",
            "CREATE ROLE admin_ci_runtime LOGIN NOSUPERUSER NOCREATEDB "
            "NOCREATEROLE NOREPLICATION NOBYPASSRLS "
            "PASSWORD 'ci-admin-runtime-password'",
            "CREATE DATABASE admin_roles_ci OWNER admin_ci_migration",
        ):
            db.execute(sql)

    with psycopg.connect(MIGRATE) as db:
        db.execute("REVOKE CREATE ON SCHEMA public FROM PUBLIC")
        db.execute("REVOKE ALL ON DATABASE admin_roles_ci FROM PUBLIC")
        db.execute("GRANT CONNECT ON DATABASE admin_roles_ci TO admin_ci_runtime")
        db.execute("GRANT USAGE ON SCHEMA public TO admin_ci_runtime")


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
    os.environ["ADMIN_PG_SCHEMA_MODE"] = "legacy"
    PostgresAuditStore(MIGRATE)
    PostgresControlStore(MIGRATE)
    PostgresLiveAnalysisProfileStore(MIGRATE)
    PostgresTaskQueue(MIGRATE, workers=1)
    PostgresAdminSessionStore(
        MIGRATE, ip_binding=lambda _: "", ua_binding=lambda _: ""
    )

    with psycopg.connect(MIGRATE) as db:
        missing = set(TABLES) - {
            r[0] for r in db.execute(
                "SELECT tablename FROM pg_tables WHERE schemaname='public'"
            )
        }
        assert not missing, missing
        db.execute(
            "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public "
            "TO admin_ci_runtime"
        )
        # Keep audit history immutable to the live application login.
        db.execute(
            "REVOKE UPDATE, DELETE ON TABLE public.admin_audit FROM admin_ci_runtime"
        )
        db.execute(
            "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public "
            "TO admin_ci_runtime"
        )


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

    # A runtime account can be a non-INHERITING member of the schema-owner
    # role while retaining SET ROLE. Such an account can still become the
    # migration owner for DDL; startup verification must fail closed.
    with psycopg.connect(FIXTURE) as bootstrap:
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
            assert "ownership" in str(exc).lower(), str(exc)
        else:
            raise AssertionError("SET-only migration-role membership was not rejected")
    finally:
        with psycopg.connect(FIXTURE) as bootstrap:
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
    print("ADMIN_PG_PREPROVISIONED_RUNTIME_OK disposable_pg17_only")


def main() -> None:
    require_ci_only()
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


if __name__ == "__main__":
    main()
