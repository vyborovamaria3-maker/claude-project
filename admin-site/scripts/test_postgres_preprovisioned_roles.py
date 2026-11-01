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
    TABLES, INDEXES, require_admin_postgres_dsn, verify_preprovisioned_schema,
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
    with psycopg.connect(FIXTURE) as bootstrap:
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
        with psycopg.connect(FIXTURE) as bootstrap:
            bootstrap.execute("REVOKE pg_execute_server_program FROM admin_ci_runtime")
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
            # The migration identity owns both the fixture database and
            # application tables; either early gate must reject SET ROLE.
            assert (
                "ownership" in str(exc).lower()
                or "database-level" in str(exc).lower()
            ), str(exc)
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
            "ADD CONSTRAINT suspicious_ci_check CHECK (char_length(name) < 5)"
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
    with psycopg.connect(FIXTURE) as bootstrap:
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
        with psycopg.connect(FIXTURE) as bootstrap:
            bootstrap.execute("REVOKE admin_ci_ddl_helper FROM admin_ci_runtime")
            bootstrap.execute("DROP ROLE admin_ci_ddl_helper")
    verify_preprovisioned_schema(RUNTIME)

    print("ADMIN_PG_PREPROVISIONED_RUNTIME_OK disposable_pg17_only")


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
                    for entry in flags.json()
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
    assert_full_admin_app_smoke()


if __name__ == "__main__":
    main()
