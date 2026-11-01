"""Fail-closed opt-in policy for a pre-provisioned Admin PostgreSQL schema.

The default legacy mode retains existing behaviour. Preprovisioned mode must
only be enabled after a reviewed migration performed by a separate schema
owner; normal Admin startup may then connect with a restricted DML login.

No DDL or privileged configuration changes occur in this module.
"""
from __future__ import annotations

import os

import psycopg


# Keep the inventory explicit. Adding a new PostgreSQL-backed Admin store or
# index MUST update this list and its restricted-role integration test.
TABLES = (
    "admin_audit",
    "revoked_admin_sessions",
    "feature_flags",
    "alerts",
    "analysis_parameter_overrides",
    "admin_background_tasks",
    "admin_security_sessions",
)
INDEXES = (
    "ix_admin_audit_created",
    "ix_admin_audit_action_created",
    "ix_revoked_admin_sessions_expires",
    "ix_alerts_status_created",
    "ix_alerts_created",
    "ix_analysis_overrides_domain",
    "ix_analysis_overrides_active",
    "ix_admin_tasks_claim",
    "ix_admin_tasks_owner_created",
    "ix_admin_security_sessions_expires",
    "ix_admin_security_sessions_user_expires",
)


def preprovisioned_schema_enabled() -> bool:
    value = os.getenv("ADMIN_PG_SCHEMA_MODE", "legacy").strip().lower()
    if value not in {"legacy", "preprovisioned"}:
        raise RuntimeError("ADMIN_PG_SCHEMA_MODE must be legacy or preprovisioned")
    return value == "preprovisioned"


def require_admin_postgres_dsn(dsn: str) -> None:
    """Never silently fall back to SQLite when restricted PG mode is requested."""
    if preprovisioned_schema_enabled() and not dsn.strip():
        raise RuntimeError(
            "ADMIN_STATE_POSTGRES_DSN is required when ADMIN_PG_SCHEMA_MODE=preprovisioned"
        )


def verify_preprovisioned_schema(dsn: str) -> None:
    """Verify restricted login and exact required schema objects before startup.

    Intentionally does not run CREATE/ALTER/GRANT, SELECT from user rows, or
    change the state. Schema owners/permissions must be reviewed separately.
    """
    if not preprovisioned_schema_enabled():
        return
    with psycopg.connect(dsn, connect_timeout=5) as db:
        with db.cursor() as cur:
            cur.execute(
                "SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, "
                "rolbypassrls FROM pg_roles WHERE rolname = current_user"
            )
            flags = cur.fetchone()
            if not flags or any(flags):
                raise RuntimeError("Admin runtime identity has unsafe PostgreSQL role flags")
            # LOGIN flags alone do not show inherited or SET-able powerful
            # predefined roles. Neither path is acceptable for an Admin DML
            # identity, particularly pg_execute_server_program.
            cur.execute(
                "SELECT pg_has_role(current_user, 'pg_read_all_data', 'MEMBER'), "
                "pg_has_role(current_user, 'pg_write_all_data', 'MEMBER'), "
                "pg_has_role(current_user, 'pg_read_server_files', 'MEMBER'), "
                "pg_has_role(current_user, 'pg_write_server_files', 'MEMBER'), "
                "pg_has_role(current_user, 'pg_execute_server_program', 'MEMBER')"
            )
            powerful_memberships = cur.fetchone()
            if not powerful_memberships or any(powerful_memberships):
                raise RuntimeError("Admin runtime has unsafe PostgreSQL predefined-role membership")
            cur.execute(
                "SELECT has_schema_privilege(current_user, 'public', 'USAGE'), "
                "has_schema_privilege(current_user, 'public', 'CREATE')"
            )
            rights = cur.fetchone()
            if not rights or rights != (True, False):
                raise RuntimeError("Admin runtime must have USAGE but not CREATE on public schema")

            cur.execute(
                "SELECT c.relname, c.relkind, "
                "pg_get_userbyid(c.relowner), pg_has_role(c.relowner, 'MEMBER'), "
                "c.relrowsecurity, c.relforcerowsecurity, "
                "has_table_privilege(current_user, c.oid, 'SELECT'), "
                "has_table_privilege(current_user, c.oid, 'INSERT'), "
                "has_table_privilege(current_user, c.oid, 'UPDATE'), "
                "has_table_privilege(current_user, c.oid, 'DELETE') "
                "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
                "WHERE n.nspname='public' AND c.relname = ANY(%s)",
                (list(TABLES),),
            )
            rows = {row[0]: row for row in cur.fetchall()}
            if set(rows) != set(TABLES):
                raise RuntimeError("Admin preprovisioned schema is missing required tables")
            for name, kind, owner, member_of_owner, rls, forced_rls, *privileges in rows.values():
                # A non-inheriting membership can still SET ROLE to the table
                # owner and execute DDL, despite current_user not owning it.
                if kind not in ("r", "p") or owner == db.info.user or member_of_owner or rls or forced_rls:
                    raise RuntimeError(f"Admin schema ownership/RLS gate failed for {name}")
                if name == "admin_audit":
                    # The audit log is append-only: SELECT and INSERT are
                    # required, but UPDATE/DELETE would allow log tampering.
                    if privileges != [True, True, False, False]:
                        raise RuntimeError("Admin runtime audit log must be append-only")
                elif not all(privileges):
                    raise RuntimeError(f"Admin runtime DML privilege missing for {name}")

            cur.execute(
                "SELECT c.relname, c.relkind FROM pg_class c "
                "JOIN pg_namespace n ON n.oid=c.relnamespace "
                "WHERE n.nspname='public' AND c.relname = ANY(%s)",
                (list(INDEXES),),
            )
            actual_indexes = {name for name, kind in cur.fetchall() if kind in ("i", "I")}
            if actual_indexes != set(INDEXES):
                raise RuntimeError("Admin preprovisioned schema is missing required indexes")

            cur.execute(
                "SELECT c.relname, pg_get_userbyid(c.relowner), "
                "has_sequence_privilege(current_user,c.oid,'USAGE') "
                "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
                "WHERE n.nspname='public' AND c.relkind='S' "
                "AND c.relname IN ('admin_audit_id_seq','alerts_id_seq')"
            )
            seqs = {row[0]: row for row in cur.fetchall()}
            if set(seqs) != {"admin_audit_id_seq", "alerts_id_seq"}:
                raise RuntimeError("Admin preprovisioned schema is missing identity sequences")
            if any(owner == db.info.user or not can_use for _,owner,can_use in seqs.values()):
                raise RuntimeError("Admin runtime sequence/ownership privilege gate failed")
