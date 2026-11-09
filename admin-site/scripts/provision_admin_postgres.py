#!/usr/bin/env python3
"""Provision Admin PostgreSQL roles without performing an ownership migration.

The bootstrap DSN is used only by this one-shot process. Existing application
objects must already have a reviewed owner mapping to the migration role.
The long-running Admin API receives the DML-only runtime DSN after its schema
contract has been verified.
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


def _ensure_login_role(db: psycopg.Connection[Any], name: str, password: str) -> None:
    _validate_role(name, password)
    exists = db.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (name,)).fetchone()
    flags = "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT"
    action = "ALTER ROLE" if exists else "CREATE ROLE"
    # PostgreSQL utility statements such as CREATE ROLE do not accept
    # protocol bind parameters in this position. Compose the password as a
    # safely quoted SQL literal instead; role names remain quoted identifiers.
    statement = sql.SQL("{} {} WITH PASSWORD {} {}").format(
        sql.SQL(action), sql.Identifier(name), sql.Literal(password), sql.SQL(flags)
    )
    db.execute(statement)


def _revoke_role_memberships(db: psycopg.Connection[Any], roles: set[str]) -> None:
    memberships = db.execute(
        """
        SELECT granted.rolname, member.rolname
        FROM pg_auth_members AS membership
        JOIN pg_roles AS granted ON granted.oid = membership.roleid
        JOIN pg_roles AS member ON member.oid = membership.member
        WHERE member.rolname = ANY(%s)
           OR granted.rolname = ANY(%s)
        """,
        (list(roles), list(roles)),
    ).fetchall()
    for granted_role, member_role in memberships:
        db.execute(
            sql.SQL("REVOKE {} FROM {}").format(
                sql.Identifier(granted_role), sql.Identifier(member_role)
            )
        )


def _assert_public_application_objects_owned(
    db: psycopg.Connection[Any], migrator_user: str
) -> None:
    """Fail closed; object ownership changes require a separate reviewed allowlist."""
    rows = db.execute(
        """
        WITH extension_members AS (
            SELECT classid, objid
            FROM pg_depend
            WHERE deptype = 'e'
        ),
        application_objects AS (
            SELECT
                n.nspname AS schema_name,
                n.nspname || '.' || c.relname AS object_name,
                c.relowner AS owner_oid
            FROM pg_class AS c
            JOIN pg_namespace AS n ON n.oid = c.relnamespace
            WHERE n.nspname <> 'information_schema'
              AND n.nspname NOT LIKE 'pg_%'
              AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
              AND NOT EXISTS (
                  SELECT 1 FROM extension_members AS e
                  WHERE e.classid = 'pg_class'::regclass AND e.objid = c.oid
              )

            UNION ALL

            SELECT
                n.nspname,
                n.nspname || '.' || p.proname || '(' ||
                    pg_get_function_identity_arguments(p.oid) || ')',
                p.proowner
            FROM pg_proc AS p
            JOIN pg_namespace AS n ON n.oid = p.pronamespace
            WHERE n.nspname <> 'information_schema'
              AND n.nspname NOT LIKE 'pg_%'
              AND NOT EXISTS (
                  SELECT 1 FROM extension_members AS e
                  WHERE e.classid = 'pg_proc'::regclass AND e.objid = p.oid
              )

            UNION ALL

            SELECT
                n.nspname,
                n.nspname || '.' || t.typname,
                t.typowner
            FROM pg_type AS t
            JOIN pg_namespace AS n ON n.oid = t.typnamespace
            WHERE n.nspname <> 'information_schema'
              AND n.nspname NOT LIKE 'pg_%'
              AND t.typtype IN ('d', 'e', 'r', 'm')
              AND NOT EXISTS (
                  SELECT 1 FROM extension_members AS e
                  WHERE e.classid = 'pg_type'::regclass AND e.objid = t.oid
              )
        )
        SELECT
            object.schema_name,
            object.object_name,
            pg_get_userbyid(object.owner_oid) AS owner_name
        FROM application_objects AS object
        WHERE object.schema_name <> 'public'
           OR object.owner_oid <> (
               SELECT oid FROM pg_roles WHERE rolname = %s
           )
        ORDER BY object.schema_name, object.object_name
        """,
        (migrator_user,),
    ).fetchall()
    if rows:
        details = ", ".join(
            f"{schema}.{name} (owner={owner})"
            for schema, name, owner in rows[:20]
        )
        suffix = " ..." if len(rows) > 20 else ""
        raise RuntimeError(
            "Admin PostgreSQL ownership preflight failed; existing application "
            "objects must be transferred through a separately reviewed, "
            f"object-level allowlist before provisioning: {details}{suffix}"
        )


def _assert_no_public_security_definer(db: psycopg.Connection[Any]) -> None:
    row = db.execute(
        """
        SELECT p.oid::regprocedure::text
        FROM pg_proc AS p
        JOIN pg_namespace AS n ON n.oid = p.pronamespace
        CROSS JOIN LATERAL aclexplode(
            COALESCE(p.proacl, acldefault('f', p.proowner))
        ) AS acl
        WHERE n.nspname = 'public'
          AND p.prosecdef
          AND acl.grantee = 0
          AND acl.privilege_type = 'EXECUTE'
          AND NOT EXISTS (
              SELECT 1
              FROM pg_depend AS extension_member
              WHERE extension_member.classid = 'pg_proc'::regclass
                AND extension_member.objid = p.oid
                AND extension_member.deptype = 'e'
          )
        LIMIT 1
        """
    ).fetchone()
    if row:
        raise RuntimeError(
            "Admin PostgreSQL provisioning blocked: SECURITY DEFINER function "
            f"{row[0]} is executable by PUBLIC; review its ACL and grant only "
            "explicit required principals"
        )


def provision_roles(
    *,
    bootstrap_dsn: str,
    app_user: str,
    app_password: str,
    migrator_user: str,
    migrator_password: str,
    backup_user: str,
    backup_password: str,
) -> None:
    roles = {app_user, migrator_user, backup_user}
    if len(roles) != 3:
        raise ValueError("Admin app, migrator and backup roles must be distinct")
    for name, password in (
        (app_user, app_password),
        (migrator_user, migrator_password),
        (backup_user, backup_password),
    ):
        _validate_role(name, password)

    with psycopg.connect(bootstrap_dsn, autocommit=True) as db:
        bootstrap_user, database = db.execute(
            "SELECT current_user, current_database()"
        ).fetchone()
        if bootstrap_user in roles:
            raise ValueError(
                "The PostgreSQL bootstrap login cannot be reused as an application role"
            )
        bootstrap_flags = db.execute(
            "SELECT rolsuper FROM pg_roles WHERE rolname = current_user"
        ).fetchone()
        if not bootstrap_flags or not bootstrap_flags[0]:
            raise RuntimeError(
                "Admin PostgreSQL role provisioning requires the configured bootstrap superuser"
            )

        database_owner = db.execute(
            """
            SELECT pg_get_userbyid(datdba)
            FROM pg_database
            WHERE datname = current_database()
            """
        ).fetchone()[0]
        if database_owner != bootstrap_user:
            raise RuntimeError(
                "Admin PostgreSQL provisioning blocked: database owner must remain "
                "the configured bootstrap identity; restore ownership through an "
                "explicit operator-approved change before retrying"
            )

        _ensure_login_role(db, app_user, app_password)
        _ensure_login_role(db, migrator_user, migrator_password)
        _ensure_login_role(db, backup_user, backup_password)
        _revoke_role_memberships(db, roles)

        # This is a read-only ownership preflight, not an ownership migration.
        # Do not REASSIGN OWNED, ALTER DATABASE OWNER, ALTER SCHEMA OWNER or
        # silently transfer existing application objects here.
        _assert_public_application_objects_owned(db, migrator_user)
        _assert_no_public_security_definer(db)

        db.execute(
            sql.SQL(
                "REVOKE CONNECT, CREATE, TEMPORARY ON DATABASE {} FROM PUBLIC"
            ).format(sql.Identifier(database))
        )
        db.execute(
            sql.SQL(
                "REVOKE CREATE, TEMPORARY ON DATABASE {} FROM {}, {}, {}"
            ).format(
                sql.Identifier(database),
                sql.Identifier(app_user),
                sql.Identifier(migrator_user),
                sql.Identifier(backup_user),
            )
        )
        db.execute("REVOKE CREATE ON SCHEMA public FROM PUBLIC")
        db.execute(
            sql.SQL("REVOKE CREATE ON SCHEMA public FROM {}, {}").format(
                sql.Identifier(app_user), sql.Identifier(backup_user)
            )
        )
        db.execute(
            sql.SQL("GRANT CONNECT ON DATABASE {} TO {}, {}, {}").format(
                sql.Identifier(database),
                sql.Identifier(app_user),
                sql.Identifier(migrator_user),
                sql.Identifier(backup_user),
            )
        )
        db.execute(
            sql.SQL("GRANT USAGE, CREATE ON SCHEMA public TO {}").format(
                sql.Identifier(migrator_user)
            )
        )
        db.execute(
            sql.SQL("GRANT USAGE ON SCHEMA public TO {}, {}").format(
                sql.Identifier(app_user), sql.Identifier(backup_user)
            )
        )

        # Remove stale grants before applying the narrow runtime and backup ACLs.
        db.execute(
            sql.SQL("REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM {}").format(
                sql.Identifier(app_user)
            )
        )
        db.execute(
            sql.SQL("REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM {}").format(
                sql.Identifier(app_user)
            )
        )
        db.execute(
            sql.SQL("REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM {}").format(
                sql.Identifier(backup_user)
            )
        )
        db.execute(
            sql.SQL("REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM {}").format(
                sql.Identifier(backup_user)
            )
        )
        db.execute(
            sql.SQL("GRANT SELECT ON ALL TABLES IN SCHEMA public TO {}").format(
                sql.Identifier(backup_user)
            )
        )
        db.execute(
            sql.SQL("GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO {}").format(
                sql.Identifier(backup_user)
            )
        )

        db.execute(
            sql.SQL(
                "ALTER DEFAULT PRIVILEGES FOR ROLE {} IN SCHEMA public "
                "REVOKE ALL ON TABLES FROM {}"
            ).format(sql.Identifier(migrator_user), sql.Identifier(app_user))
        )
        db.execute(
            sql.SQL(
                "ALTER DEFAULT PRIVILEGES FOR ROLE {} IN SCHEMA public "
                "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {}"
            ).format(sql.Identifier(migrator_user), sql.Identifier(app_user))
        )
        db.execute(
            sql.SQL(
                "ALTER DEFAULT PRIVILEGES FOR ROLE {} IN SCHEMA public "
                "REVOKE ALL ON SEQUENCES FROM {}"
            ).format(sql.Identifier(migrator_user), sql.Identifier(app_user))
        )
        db.execute(
            sql.SQL(
                "ALTER DEFAULT PRIVILEGES FOR ROLE {} IN SCHEMA public "
                "GRANT USAGE, SELECT ON SEQUENCES TO {}"
            ).format(sql.Identifier(migrator_user), sql.Identifier(app_user))
        )
        db.execute(
            sql.SQL(
                "ALTER DEFAULT PRIVILEGES FOR ROLE {} IN SCHEMA public "
                "REVOKE ALL ON TABLES FROM {}"
            ).format(sql.Identifier(migrator_user), sql.Identifier(backup_user))
        )
        db.execute(
            sql.SQL(
                "ALTER DEFAULT PRIVILEGES FOR ROLE {} IN SCHEMA public "
                "GRANT SELECT ON TABLES TO {}"
            ).format(sql.Identifier(migrator_user), sql.Identifier(backup_user))
        )
        db.execute(
            sql.SQL(
                "ALTER DEFAULT PRIVILEGES FOR ROLE {} IN SCHEMA public "
                "REVOKE ALL ON SEQUENCES FROM {}"
            ).format(sql.Identifier(migrator_user), sql.Identifier(backup_user))
        )
        db.execute(
            sql.SQL(
                "ALTER DEFAULT PRIVILEGES FOR ROLE {} IN SCHEMA public "
                "GRANT SELECT ON SEQUENCES TO {}"
            ).format(sql.Identifier(migrator_user), sql.Identifier(backup_user))
        )
        db.execute(
            sql.SQL(
                "ALTER DEFAULT PRIVILEGES FOR ROLE {} IN SCHEMA public "
                "REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC"
            ).format(sql.Identifier(migrator_user))
        )
        db.execute(
            sql.SQL(
                "ALTER ROLE {} SET default_transaction_read_only = on"
            ).format(sql.Identifier(backup_user))
        )
        db.execute(
            sql.SQL("ALTER ROLE {} RESET default_transaction_read_only").format(
                sql.Identifier(app_user)
            )
        )
        db.execute(
            sql.SQL("ALTER ROLE {} RESET default_transaction_read_only").format(
                sql.Identifier(migrator_user)
            )
        )


def provision_schema(
    *,
    migrator_dsn: str,
    runtime_dsn: str,
    app_user: str,
    migrator_user: str,
    backup_user: str,
) -> None:
    # Constructors own the canonical DDL. This mode is intentionally enabled
    # only in the short-lived migration/provisioner process.
    os.environ["ADMIN_PG_SCHEMA_MODE"] = "legacy"
    os.environ["ADMIN_STATE_POSTGRES_DSN"] = migrator_dsn
    from app.postgres_admin_state import (
        PostgresAuditStore,
        PostgresControlStore,
        PostgresLiveAnalysisProfileStore,
    )
    from app.postgres_security_store import PostgresAdminSessionStore
    from app.postgres_task_queue import PostgresTaskQueue

    PostgresAuditStore(migrator_dsn)
    PostgresControlStore(migrator_dsn)
    PostgresLiveAnalysisProfileStore(migrator_dsn)
    PostgresTaskQueue(migrator_dsn, workers=1)
    PostgresAdminSessionStore(
        migrator_dsn, ip_binding=lambda _: "", ua_binding=lambda _: ""
    )

    with psycopg.connect(migrator_dsn, autocommit=True) as db:
        db.execute(
            sql.SQL(
                "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM {}"
            ).format(sql.Identifier(app_user))
        )
        db.execute(
            sql.SQL(
                "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {}"
            ).format(sql.Identifier(app_user))
        )
        db.execute(
            sql.SQL(
                "REVOKE ALL ON TABLE public.admin_audit FROM {}"
            ).format(sql.Identifier(app_user))
        )
        db.execute(
            sql.SQL(
                "GRANT SELECT, INSERT ON TABLE public.admin_audit TO {}"
            ).format(sql.Identifier(app_user))
        )
        db.execute(
            sql.SQL(
                "REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM {}"
            ).format(sql.Identifier(app_user))
        )
        db.execute(
            sql.SQL(
                "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {}"
            ).format(sql.Identifier(app_user))
        )
        db.execute(
            sql.SQL(
                "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM {}"
            ).format(sql.Identifier(backup_user))
        )
        db.execute(
            sql.SQL(
                "GRANT SELECT ON ALL TABLES IN SCHEMA public TO {}"
            ).format(sql.Identifier(backup_user))
        )
        db.execute(
            sql.SQL(
                "REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM {}"
            ).format(sql.Identifier(backup_user))
        )
        db.execute(
            sql.SQL(
                "GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO {}"
            ).format(sql.Identifier(backup_user))
        )

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
    migrator_user = os.environ.get(
        "ADMIN_STATE_MIGRATOR_USER", "potapoff_admin_migrator"
    )
    migrator_password = os.environ["ADMIN_STATE_MIGRATOR_PASSWORD"]
    backup_user = os.environ.get(
        "ADMIN_STATE_BACKUP_USER", "potapoff_admin_backup"
    )
    backup_password = os.environ["ADMIN_STATE_BACKUP_PASSWORD"]
    provision_roles(
        bootstrap_dsn=bootstrap_dsn,
        app_user=app_user,
        app_password=app_password,
        migrator_user=migrator_user,
        migrator_password=migrator_password,
        backup_user=backup_user,
        backup_password=backup_password,
    )
    provision_schema(
        migrator_dsn=migrator_dsn,
        runtime_dsn=runtime_dsn,
        app_user=app_user,
        migrator_user=migrator_user,
        backup_user=backup_user,
    )
    print("ADMIN_POSTGRES_ROLE_PROVISIONING_OK")


if __name__ == "__main__":
    main()
