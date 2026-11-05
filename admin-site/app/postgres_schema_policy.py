"""Fail-closed opt-in policy for a pre-provisioned Admin PostgreSQL schema.

The default legacy mode retains existing behaviour. Preprovisioned mode must
only be enabled after a reviewed migration performed by a separate schema
owner; normal Admin startup may then connect with a restricted DML login.

No DDL or privileged configuration changes occur in this module.
"""
from __future__ import annotations

import os
import re

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



# Versioned contract for the exact schema produced by the five legacy Admin
# store constructors. All columns are checked, including nullability, primary
# keys and index definitions; adding a store must update this contract.
# PostgreSQL format_type() uses 'timestamp with time zone' for TIMESTAMPTZ.
_T = "timestamp with time zone"
SCHEMA_COLUMNS = {
    "admin_audit": (
        ("id", "bigint", True), ("created_at", _T, True),
        ("username", "text", False), ("ip_address", "text", False),
        ("action", "text", True), ("resource", "text", False),
        ("success", "boolean", True), ("details_json", "jsonb", True),
    ),
    "revoked_admin_sessions": (
        ("nonce", "text", True), ("expires_at", "bigint", True),
        ("revoked_at", _T, True),
    ),
    "feature_flags": (
        ("name", "text", True), ("enabled", "boolean", True),
        ("description", "text", True), ("updated_by", "text", False),
        ("updated_at", _T, True),
    ),
    "alerts": (
        ("id", "bigint", True), ("level", "text", True),
        ("title", "text", True), ("message", "text", True),
        ("source", "text", True), ("status", "text", True),
        ("created_at", _T, True), ("acknowledged_at", _T, False),
        ("acknowledged_by", "text", False),
    ),
    "analysis_parameter_overrides": (
        ("domain", "text", True), ("key", "text", True),
        ("enabled", "integer", True), ("threshold", "text", True),
        ("label", "text", False), ("source", "text", False),
        ("value_type", "text", False), ("scale", "text", False),
        ("description", "text", False), ("custom", "integer", True),
        ("deleted", "integer", True), ("updated_by", "text", False),
        ("updated_at", "text", True),
    ),
    "admin_background_tasks": (
        ("id", "text", True), ("kind", "text", True),
        ("owner", "text", True), ("state", "text", True),
        ("payload_json", "jsonb", True), ("result_json", "jsonb", False),
        ("error", "text", False), ("created_at", _T, True),
        ("started_at", _T, False), ("finished_at", _T, False),
        ("lease_owner", "text", False), ("lease_expires_at", _T, False),
    ),
    "admin_security_sessions": (
        ("nonce", "text", True), ("username", "text", True),
        ("issued_at", "bigint", True), ("expires_at", "bigint", True),
        ("last_seen_at", "bigint", True), ("mfa_verified_at", "bigint", False),
        ("reauth_until", "bigint", False), ("ip_hash", "text", False),
        ("user_agent_hash", "text", False),
    ),
}
# Defaults are part of the runtime contract, not optional decoration:
# missing defaults can make INSERT paths fail even with correct column names.
SCHEMA_DEFAULTS = {
    ("admin_audit", "id"): "nextval('admin_audit_id_seq'::regclass)",
    ("admin_audit", "details_json"): "'{}'::jsonb",
    ("feature_flags", "enabled"): "false",
    ("feature_flags", "description"): "''::text",
    ("alerts", "id"): "nextval('alerts_id_seq'::regclass)",
    ("alerts", "source"): "'control-center'::text",
    ("alerts", "status"): "'open'::text",
    ("analysis_parameter_overrides", "threshold"): "''::text",
    ("analysis_parameter_overrides", "custom"): "0",
    ("analysis_parameter_overrides", "deleted"): "0",
    ("admin_background_tasks", "payload_json"): "'{}'::jsonb",
}

PRIMARY_KEYS = {
    "admin_audit": ("id",),
    "revoked_admin_sessions": ("nonce",),
    "feature_flags": ("name",),
    "alerts": ("id",),
    "analysis_parameter_overrides": ("domain", "key"),
    "admin_background_tasks": ("id",),
    "admin_security_sessions": ("nonce",),
}
# (owning table, index key expressions, optional partial predicate)
INDEX_CONTRACT = {
    "ix_admin_audit_created": ("admin_audit", ("created_at DESC",), None),
    "ix_admin_audit_action_created": ("admin_audit", ("action", "created_at DESC"), None),
    "ix_revoked_admin_sessions_expires": ("revoked_admin_sessions", ("expires_at",), None),
    "ix_alerts_status_created": ("alerts", ("status", "created_at DESC"), None),
    "ix_alerts_created": ("alerts", ("created_at DESC",), None),
    "ix_analysis_overrides_domain": ("analysis_parameter_overrides", ("domain", "deleted", "enabled"), None),
    "ix_analysis_overrides_active": ("analysis_parameter_overrides", ("domain", "key"), "deleted = 0"),
    "ix_admin_tasks_claim": ("admin_background_tasks", ("state", "created_at"), None),
    "ix_admin_tasks_owner_created": ("admin_background_tasks", ("owner", "created_at DESC"), None),
    "ix_admin_security_sessions_expires": ("admin_security_sessions", ("expires_at",), None),
    "ix_admin_security_sessions_user_expires": ("admin_security_sessions", ("username", "expires_at DESC"), None),
}


def _normal_sql(value: str | None) -> str | None:
    if value is None:
        return None
    return " ".join(value.lower().replace("(", " ").replace(")", " ").split())

def _index_key_signature(expr: str, sort_options: int) -> tuple[str, bool, bool]:
    """Compare actual btree ordering bits instead of pretty-printed ASC/DESC.

    pg_get_indexdef(column) can render explicit default NULLS FIRST/LAST.
    The indoption bits are authoritative: 1=DESC and 2=NULLS_FIRST.
    """
    plain = re.sub(r"\s+NULLS\s+(?:FIRST|LAST)\s*$", "", expr, flags=re.I)
    plain = re.sub(r"\s+(?:ASC|DESC)\s*$", "", plain, flags=re.I)
    return (_normal_sql(plain) or "", bool(sort_options & 1), bool(sort_options & 2))


def _expected_index_key(expr: str) -> tuple[str, bool, bool]:
    # The reviewed contract contains only simple btree columns with the
    # PostgreSQL default NULLS order (ASC LAST, DESC FIRST).
    normalized = _normal_sql(expr) or ""
    desc = normalized.endswith(" desc")
    return (normalized.removesuffix(" desc"), desc, desc)


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
            # Role attributes such as CREATEROLE, CREATEDB, REPLICATION and
            # BYPASSRLS are not ordinary table grants. A custom NOLOGIN role
            # can still confer them when the runtime identity may SET ROLE.
            cur.execute(
                "SELECT r.rolname FROM pg_roles r "
                "WHERE r.rolname <> current_user "
                "AND pg_has_role(current_user,r.oid,'SET') "
                "AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole "
                "OR r.rolreplication OR r.rolbypassrls) LIMIT 1"
            )
            privileged_set_role = cur.fetchone()
            if privileged_set_role:
                raise RuntimeError("Admin runtime has SET-reachable privileged role attributes")
            cur.execute(
                "SELECT has_schema_privilege(current_user, 'public', 'USAGE'), "
                "has_schema_privilege(current_user, 'public', 'CREATE')"
            )
            rights = cur.fetchone()
            if not rights or rights != (True, False):
                raise RuntimeError("Admin runtime must have USAGE but not CREATE on public schema")
            # Explicitly scan every non-system schema: a login with CREATE
            # on an auxiliary schema can still issue DDL despite lacking
            # CREATE on public and at the database level.
            cur.execute(
                "SELECT n.nspname, has_schema_privilege(current_user,n.oid,'CREATE'), "
                "pg_has_role(n.nspowner,'MEMBER') "
                "FROM pg_namespace n WHERE n.nspname <> 'information_schema' "
                "AND n.nspname NOT LIKE 'pg_%'"
            )
            for schema, can_create, owner_member in cur.fetchall():
                if can_create or owner_member:
                    raise RuntimeError(f"Admin runtime has DDL privileges in schema: {schema}")

            # SET-able membership in an unrelated role may confer CREATE
            # even when the login has no direct DDL right and does not own
            # any schema/table. Check every reachable role in every user schema.
            cur.execute(
                "SELECT n.nspname, r.rolname FROM pg_namespace n CROSS JOIN pg_roles r "
                "WHERE n.nspname <> 'information_schema' "
                "AND n.nspname NOT LIKE 'pg_%' "
                "AND pg_has_role(current_user,r.oid,'MEMBER') "
                "AND has_schema_privilege(r.oid,n.oid,'CREATE') LIMIT 1"
            )
            if cur.fetchone():
                raise RuntimeError("Admin runtime has SET-reachable schema DDL privileges")
            cur.execute(
                "SELECT r.rolname FROM pg_roles r JOIN pg_database d "
                "ON d.datname=current_database() "
                "WHERE pg_has_role(current_user,r.oid,'MEMBER') "
                "AND (has_database_privilege(r.oid,d.oid,'CREATE') "
                "OR has_database_privilege(r.oid,d.oid,'TEMPORARY')) LIMIT 1"
            )
            if cur.fetchone():
                raise RuntimeError("Admin runtime has SET-reachable database DDL privileges")

            cur.execute(
                "SELECT has_database_privilege(current_user, current_database(), 'CONNECT'), "
                "has_database_privilege(current_user, current_database(), 'CREATE'), "
                "has_database_privilege(current_user, current_database(), 'TEMPORARY'), "
                "pg_has_role(d.datdba, 'MEMBER') "
                "FROM pg_database d WHERE d.datname=current_database()"
            )
            database_rights = cur.fetchone()
            # A runtime role that can CREATE schemas, create temp objects or
            # SET ROLE to the database owner is not a strict DML-only login.
            if database_rights != (True, False, False, False):
                raise RuntimeError("Admin runtime has unsafe database-level privileges")

            cur.execute(
                "SELECT c.relname, c.relkind, "
                "pg_get_userbyid(c.relowner), pg_has_role(c.relowner, 'MEMBER'), "
                "c.relrowsecurity, c.relforcerowsecurity, "
                "has_table_privilege(current_user, c.oid, 'SELECT'), "
                "has_table_privilege(current_user, c.oid, 'INSERT'), "
                "has_table_privilege(current_user, c.oid, 'UPDATE'), "
                "has_table_privilege(current_user, c.oid, 'DELETE'), "
                "has_table_privilege(current_user, c.oid, 'TRUNCATE'), "
                "has_table_privilege(current_user, c.oid, 'REFERENCES'), "
                "has_table_privilege(current_user, c.oid, 'TRIGGER'), "
                "has_table_privilege(current_user, c.oid, 'MAINTAIN'), "
                "has_any_column_privilege(current_user, c.oid, 'UPDATE') "
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
                dml = privileges[:4]
                elevated = privileges[4:8]
                any_column_update = privileges[8]
                if any(elevated):
                    # TRUNCATE bypasses the intended audit-log immutability
                    # even when UPDATE/DELETE have been explicitly revoked.
                    raise RuntimeError(f"Admin runtime has unsafe table privileges for {name}")
                if name == "admin_audit":
                    # Table UPDATE may be revoked but UPDATE(column) still
                    # permits audit tampering. Detect both kinds of grant.
                    if dml != [True, True, False, False] or any_column_update:
                        raise RuntimeError("Admin runtime audit log must be append-only")
                elif not all(dml):
                    raise RuntimeError(f"Admin runtime DML privilege missing for {name}")

            # Reject a damaged/old schema that happens to reuse correct
            # table names. Compare every application column's type/nullability
            # and the ordered PK columns from real PostgreSQL catalogs.
            cur.execute(
                "SELECT c.relname, a.attname, "
                "format_type(a.atttypid,a.atttypmod), a.attnotnull "
                "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
                "JOIN pg_attribute a ON a.attrelid=c.oid "
                "WHERE n.nspname='public' AND c.relname=ANY(%s) "
                "AND a.attnum>0 AND NOT a.attisdropped "
                "ORDER BY c.relname,a.attnum",
                (list(SCHEMA_COLUMNS),),
            )
            schema_columns = {name: [] for name in SCHEMA_COLUMNS}
            for table, name, typ, notnull in cur.fetchall():
                schema_columns[table].append((name, typ, notnull))
            if {name: tuple(cols) for name, cols in schema_columns.items()} != SCHEMA_COLUMNS:
                raise RuntimeError("Admin preprovisioned schema column contract mismatch")

            cur.execute(
                "SELECT c.relname, array_agg(a.attname ORDER BY k.ord) "
                "FROM pg_constraint con "
                "JOIN pg_class c ON c.oid=con.conrelid "
                "JOIN pg_namespace n ON n.oid=c.relnamespace "
                "JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum,ord) ON true "
                "JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum "
                "WHERE con.contype='p' AND n.nspname='public' AND c.relname=ANY(%s) "
                "GROUP BY c.relname",
                (list(PRIMARY_KEYS),),
            )
            keys = {name: tuple(cols) for name, cols in cur.fetchall()}
            if keys != PRIMARY_KEYS:
                raise RuntimeError("Admin preprovisioned schema primary-key contract mismatch")
            cur.execute(
                "SELECT c.relname,a.attname,pg_get_expr(d.adbin,d.adrelid) "
                "FROM pg_attrdef d "
                "JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum "
                "JOIN pg_class c ON c.oid=d.adrelid "
                "JOIN pg_namespace n ON n.oid=c.relnamespace "
                "WHERE n.nspname='public' AND c.relname=ANY(%s)",
                (list(SCHEMA_COLUMNS),),
            )
            actual_defaults = {
                (table, column): _normal_sql(expr)
                for table, column, expr in cur.fetchall()
            }
            expected_defaults = {
                key: _normal_sql(expr) for key, expr in SCHEMA_DEFAULTS.items()
            }
            if actual_defaults != expected_defaults:
                raise RuntimeError("Admin preprovisioned schema default contract mismatch")
            # All legacy Admin tables have primary keys but no additional
            # CHECK/FOREIGN KEY/UNIQUE constraints. An unreviewed constraint
            # can reject legitimate runtime writes.
            cur.execute(
                "SELECT count(*) FROM pg_constraint con "
                "JOIN pg_class c ON c.oid=con.conrelid "
                "JOIN pg_namespace n ON n.oid=c.relnamespace "
                "WHERE n.nspname='public' AND c.relname=ANY(%s) "
                "AND con.contype <> 'p'",
                (list(SCHEMA_COLUMNS),),
            )
            if cur.fetchone()[0] != 0:
                raise RuntimeError("Admin preprovisioned schema unexpected constraint")

            cur.execute(
                "SELECT c.relname, c.relkind FROM pg_class c "
                "JOIN pg_namespace n ON n.oid=c.relnamespace "
                "WHERE n.nspname='public' AND c.relname = ANY(%s)",
                (list(INDEXES),),
            )
            actual_indexes = {name for name, kind in cur.fetchall() if kind in ("i", "I")}
            if actual_indexes != set(INDEX_CONTRACT):
                raise RuntimeError("Admin preprovisioned schema is missing required indexes")
            # An identically named index on the wrong table or on different
            # columns must never satisfy the preflight gate.
            cur.execute(
                "SELECT idx.relname, tbl.relname, am.amname, "
                "i.indisunique, i.indisvalid, i.indisready, "
                "pg_get_expr(i.indpred,i.indrelid), "
                "ARRAY(SELECT pg_get_indexdef(idx.oid,k,true) "
                "FROM generate_series(1,i.indnkeyatts) k ORDER BY k), "
                "ARRAY(SELECT i.indoption[k-1] "
                "FROM generate_series(1,i.indnkeyatts) k ORDER BY k) "
                "FROM pg_class idx "
                "JOIN pg_index i ON i.indexrelid=idx.oid "
                "JOIN pg_class tbl ON tbl.oid=i.indrelid "
                "JOIN pg_namespace n ON n.oid=idx.relnamespace "
                "JOIN pg_am am ON am.oid=idx.relam "
                "WHERE n.nspname='public' AND idx.relname=ANY(%s)",
                (list(INDEX_CONTRACT),),
            )
            for name, table, method, unique, valid, ready, pred, exprs, sort_options in cur.fetchall():
                expected_table, expected_exprs, expected_pred = INDEX_CONTRACT[name]
                if (
                    table != expected_table or method != "btree"
                    or unique or not valid or not ready
                    or tuple(
                        _index_key_signature(x, option)
                        for x, option in zip(exprs, sort_options, strict=True)
                    ) != tuple(_expected_index_key(x) for x in expected_exprs)
                    or _normal_sql(pred) != _normal_sql(expected_pred)
                ):
                    raise RuntimeError(f"Admin preprovisioned schema index definition mismatch: {name}")

            cur.execute(
                "SELECT c.relname, pg_get_userbyid(c.relowner), "
                "pg_has_role(c.relowner,'MEMBER'), "
                "has_sequence_privilege(current_user,c.oid,'USAGE'), "
                "has_sequence_privilege(current_user,c.oid,'UPDATE') "
                "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
                "WHERE n.nspname='public' AND c.relkind='S' "
                "AND c.relname IN ('admin_audit_id_seq','alerts_id_seq')"
            )
            seqs = {row[0]: row for row in cur.fetchall()}
            if set(seqs) != {"admin_audit_id_seq", "alerts_id_seq"}:
                raise RuntimeError("Admin preprovisioned schema is missing identity sequences")
            if any(
                owner == db.info.user or member_of_owner or not can_use or can_update
                for _, owner, member_of_owner, can_use, can_update in seqs.values()
            ):
                raise RuntimeError("Admin runtime sequence/ownership privilege gate failed")
