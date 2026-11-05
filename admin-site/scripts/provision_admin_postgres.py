#!/usr/bin/env python3
"""Idempotently provision the Admin PostgreSQL owner/runtime/backup roles and schema.

The bootstrap DSN is used only by this one-shot process. The long-running Admin
API receives the DML-only runtime DSN after the schema contract is verified.
"""
from __future__ import annotations

import os
import re
from typing import Any

import psycopg
from psycopg import sql

ROLE_RE = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")
PASSWORD_RE = re.compile(r"^[A-Fa-f0-9]{64}$")


def _validate_role(name: str, password: str) -> None:
    if not ROLE_RE.fullmatch(name):
        raise ValueError(f"Unsafe PostgreSQL role identifier: {name!r}")
    if not PASSWORD_RE.fullmatch(password):
        raise ValueError(f"PostgreSQL role password for {name} must be 64 hex characters")


def _ensure_login_role(db: psycopg.Connection[Any], name: str, password: str, *, bypass_rls: bool = False) -> None:
    _validate_role(name, password)
    exists = db.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (name,)).fetchone()
    flags = "NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION " + ("BYPASSRLS" if bypass_rls else "NOBYPASSRLS")
    action = "ALTER ROLE" if exists else "CREATE ROLE"
    # PostgreSQL utility statements such as CREATE ROLE do not accept
    # protocol bind parameters in this position. Compose the password as a
    # safely quoted SQL literal instead; role names remain quoted identifiers.
    statement = sql.SQL("{} {} WITH LOGIN PASSWORD {} {}").format(
        sql.SQL(action), sql.Identifier(name), sql.Literal(password), sql.SQL(flags)
    )
    db.execute(statement)


def provision_roles(
    *, bootstrap_dsn: str, app_user: str, app_password: str,
    migrator_user: str, migrator_password: str, backup_user: str, backup_password: str,
) -> None:
    roles = {app_user, migrator_user, backup_user}
    if len(roles) != 3:
        raise ValueError("Admin app, migrator and backup roles must be distinct")
    for name, password in ((app_user, app_password), (migrator_user, migrator_password), (backup_user, backup_password)):
        _validate_role(name, password)

    with psycopg.connect(bootstrap_dsn, autocommit=True) as db:
        bootstrap_user, database = db.execute("SELECT current_user, current_database()").fetchone()
        if bootstrap_user in roles:
            raise ValueError("The PostgreSQL bootstrap login cannot be reused as an application role")
        _ensure_login_role(db, app_user, app_password)
        _ensure_login_role(db, migrator_user, migrator_password)
        _ensure_login_role(db, backup_user, backup_password, bypass_rls=True)

        # Transfer existing application objects and database ownership to the
        # non-superuser migrator. The bootstrap account remains available only
        # to this provisioner and emergency/global-catalog operations.
        db.execute(sql.SQL("REASSIGN OWNED BY {} TO {}").format(
            sql.Identifier(bootstrap_user), sql.Identifier(migrator_user)
        ))
        db.execute(sql.SQL("ALTER DATABASE {} OWNER TO {}").format(
            sql.Identifier(database), sql.Identifier(migrator_user)
        ))
        db.execute(sql.SQL("REVOKE CONNECT, CREATE, TEMPORARY ON DATABASE {} FROM PUBLIC").format(
            sql.Identifier(database)
        ))
        db.execute("REVOKE CREATE ON SCHEMA public FROM PUBLIC")
        db.execute(sql.SQL("ALTER SCHEMA public OWNER TO {}").format(sql.Identifier(migrator_user)))
        db.execute(sql.SQL("GRANT USAGE, CREATE ON SCHEMA public TO {}").format(sql.Identifier(migrator_user)))
        db.execute(sql.SQL("GRANT CONNECT ON DATABASE {} TO {}, {}, {}").format(
            sql.Identifier(database), sql.Identifier(app_user),
            sql.Identifier(migrator_user), sql.Identifier(backup_user)
        ))
        db.execute(sql.SQL("GRANT USAGE ON SCHEMA public TO {}").format(sql.Identifier(app_user)))
        db.execute(sql.SQL(
            "ALTER DEFAULT PRIVILEGES FOR ROLE {} IN SCHEMA public "
            "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {}"
        ).format(sql.Identifier(migrator_user), sql.Identifier(app_user)))
        db.execute(sql.SQL(
            "ALTER DEFAULT PRIVILEGES FOR ROLE {} IN SCHEMA public "
            "GRANT USAGE, SELECT ON SEQUENCES TO {}"
        ).format(sql.Identifier(migrator_user), sql.Identifier(app_user)))
        db.execute(sql.SQL("GRANT pg_read_all_data TO {}").format(sql.Identifier(backup_user)))


def provision_schema(*, migrator_dsn: str, runtime_dsn: str, app_user: str, migrator_user: str) -> None:
    # Constructors own the canonical DDL. This mode is intentionally enabled
    # only in the short-lived migration/provisioner process.
    os.environ["ADMIN_PG_SCHEMA_MODE"] = "legacy"
    os.environ["ADMIN_STATE_POSTGRES_DSN"] = migrator_dsn
    from app.postgres_admin_state import (
        PostgresAuditStore, PostgresControlStore, PostgresLiveAnalysisProfileStore,
    )
    from app.postgres_security_store import PostgresAdminSessionStore
    from app.postgres_task_queue import PostgresTaskQueue

    PostgresAuditStore(migrator_dsn)
    PostgresControlStore(migrator_dsn)
    PostgresLiveAnalysisProfileStore(migrator_dsn)
    PostgresTaskQueue(migrator_dsn, workers=1)
    PostgresAdminSessionStore(migrator_dsn, ip_binding=lambda _: "", ua_binding=lambda _: "")

    with psycopg.connect(migrator_dsn, autocommit=True) as db:
        db.execute(sql.SQL(
            "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {}"
        ).format(sql.Identifier(app_user)))
        db.execute(sql.SQL(
            "REVOKE UPDATE, DELETE ON TABLE public.admin_audit FROM {}"
        ).format(sql.Identifier(app_user)))
        db.execute(sql.SQL(
            "GRANT SELECT, INSERT ON TABLE public.admin_audit TO {}"
        ).format(sql.Identifier(app_user)))
        db.execute(sql.SQL(
            "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {}"
        ).format(sql.Identifier(app_user)))
        db.execute(sql.SQL(
            "ALTER DEFAULT PRIVILEGES FOR ROLE {} IN SCHEMA public "
            "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {}"
        ).format(sql.Identifier(migrator_user), sql.Identifier(app_user)))
        db.execute(sql.SQL(
            "ALTER DEFAULT PRIVILEGES FOR ROLE {} IN SCHEMA public "
            "GRANT USAGE, SELECT ON SEQUENCES TO {}"
        ).format(sql.Identifier(migrator_user), sql.Identifier(app_user)))

    os.environ["ADMIN_PG_SCHEMA_MODE"] = "preprovisioned"
    os.environ["ADMIN_STATE_POSTGRES_DSN"] = runtime_dsn
    from app.postgres_schema_policy import verify_preprovisioned_schema
    verify_preprovisioned_schema(runtime_dsn)


def main() -> None:
    bootstrap_dsn = os.environ["ADMIN_STATE_BOOTSTRAP_DSN"]
    migrator_dsn = os.environ["ADMIN_STATE_MIGRATOR_DSN"]
    runtime_dsn = os.environ["ADMIN_STATE_RUNTIME_DSN"]
    app_user = os.environ.get("ADMIN_STATE_APP_USER", "potapoff_admin_app")
    app_password = os.environ["ADMIN_STATE_APP_PASSWORD"]
    migrator_user = os.environ.get("ADMIN_STATE_MIGRATOR_USER", "potapoff_admin_migrator")
    migrator_password = os.environ["ADMIN_STATE_MIGRATOR_PASSWORD"]
    backup_user = os.environ.get("ADMIN_STATE_BACKUP_USER", "potapoff_admin_backup")
    backup_password = os.environ["ADMIN_STATE_BACKUP_PASSWORD"]
    provision_roles(
        bootstrap_dsn=bootstrap_dsn, app_user=app_user, app_password=app_password,
        migrator_user=migrator_user, migrator_password=migrator_password,
        backup_user=backup_user, backup_password=backup_password,
    )
    provision_schema(
        migrator_dsn=migrator_dsn, runtime_dsn=runtime_dsn,
        app_user=app_user, migrator_user=migrator_user,
    )
    print("ADMIN_POSTGRES_ROLE_PROVISIONING_OK")


if __name__ == "__main__":
    main()
