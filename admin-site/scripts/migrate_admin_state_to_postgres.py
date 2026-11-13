from __future__ import annotations

import contextlib
import hashlib
import json
import os
import sqlite3
import sys
from pathlib import Path

import psycopg
from psycopg import sql
from psycopg.rows import dict_row

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.postgres_admin_state import PostgresAuditStore, PostgresControlStore, PostgresLiveAnalysisProfileStore
from app.postgres_security_store import PostgresAdminSessionStore


MIGRATION_KEY = "admin-sqlite-to-postgres-v1"

# The migration must refuse silent data loss. Every migrated table has a
# known shape; extra SQLite columns would be dropped by the fixed SELECT
# lists below and missing columns would break the copy, so the schema is
# verified before any row is read.
EXPECTED_TABLE_COLUMNS: dict[str, tuple[str, ...]] = {
    "feature_flags": ("name", "enabled", "description", "updated_by", "updated_at"),
    "alerts": (
        "id", "level", "title", "message", "source", "status",
        "created_at", "acknowledged_at", "acknowledged_by",
    ),
    "analysis_parameter_overrides": (
        "domain", "key", "enabled", "threshold", "label", "source", "value_type",
        "scale", "description", "custom", "deleted", "updated_by", "updated_at",
    ),
    "admin_audit": (
        "id", "created_at", "username", "ip_address", "action", "resource",
        "success", "details_json",
    ),
    "revoked_admin_sessions": ("nonce", "expires_at", "revoked_at"),
}


def _assert_expected_columns(source: sqlite3.Connection, table: str) -> None:
    expected = EXPECTED_TABLE_COLUMNS.get(table)
    if expected is None:
        return
    actual = [
        str(row["name"])
        for row in source.execute(f"PRAGMA table_info({table})").fetchall()
    ]
    unknown = [column for column in actual if column not in expected]
    missing = [column for column in expected if column not in actual]
    if unknown or missing:
        raise SystemExit(
            f"SQLite {table} schema drift: unknown_columns={unknown} "
            f"missing_columns={missing}; refusing a migration that would "
            "silently drop or fail to copy data"
        )


def _table_exists(db: sqlite3.Connection, table: str) -> bool:
    row = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()
    return row is not None


def _json_object(value: str | None, row_id: object) -> str:
    raw = value or "{}"
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(
            f"SQLite admin_audit id={row_id} has corrupt details_json: {exc}; "
            "repair the source row before migrating"
        )
    if not isinstance(parsed, dict):
        raise SystemExit(
            f"SQLite admin_audit id={row_id} details_json is not a JSON object; "
            "refusing to replace it with {{}}"
        )
    return json.dumps(parsed, ensure_ascii=False, default=str)


def _sqlite_state_fingerprint(source: sqlite3.Connection) -> str:
    """Hash the logical source rows so a stale legacy DB cannot overwrite PG state."""
    digest = hashlib.sha256()
    tables = (
        ("feature_flags", "name"),
        ("alerts", "id"),
        ("analysis_parameter_overrides", "domain,key"),
        ("admin_audit", "id"),
        ("revoked_admin_sessions", "nonce"),
    )
    for table, ordering in tables:
        if not _table_exists(source, table):
            digest.update(f"{table}:absent\n".encode("utf-8"))
            continue
        columns = [
            str(row["name"])
            for row in source.execute(f"PRAGMA table_info({table})").fetchall()
        ]
        digest.update(
            json.dumps([table, columns], ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        )
        digest.update(b"\n")
        for row in source.execute(f"SELECT * FROM {table} ORDER BY {ordering}"):
            values = [row[column] for column in columns]
            digest.update(
                json.dumps(values, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8")
            )
            digest.update(b"\n")
    return digest.hexdigest()


def _assert_no_target_key_conflicts(
    cur: psycopg.Cursor,
    source: sqlite3.Connection,
    table: str,
    key_columns: tuple[str, ...],
    order_by: str,
) -> None:
    """Fail closed rather than overwriting independently-created PostgreSQL state."""
    if not _table_exists(source, table):
        return
    where = sql.SQL(" AND ").join(
        sql.SQL("{} = %s").format(sql.Identifier(column))
        for column in key_columns
    )
    query = sql.SQL("SELECT 1 FROM {} WHERE {} LIMIT 1").format(
        sql.Identifier(table), where
    )
    selected = ", ".join(key_columns)
    for _row in source.execute(
        f"SELECT {selected} FROM {table} ORDER BY {order_by}"
    ):
        cur.execute(query, tuple(_row[column] for column in key_columns))
        if cur.fetchone():
            raise SystemExit(
                f"PostgreSQL target conflict in {table}; refusing to overwrite "
                "existing state; operator reconciliation required"
            )


def _assert_keys_migrated(
    cur: psycopg.Cursor,
    table: str,
    key_column: str,
    keys: list[object],
) -> None:
    """Fail closed when any source row did not reach PostgreSQL."""
    if not keys:
        return
    cur.execute(
        sql.SQL("SELECT count(*) FROM {} WHERE {} = ANY(%s)").format(
            sql.Identifier(table), sql.Identifier(key_column)
        ),
        (keys,),
    )
    row = cur.fetchone()
    migrated = int(row["count"])
    if migrated != len(keys):
        raise SystemExit(
            f"Incomplete PostgreSQL transfer for {table}: "
            f"{migrated} of {len(keys)} source keys present; "
            "migration marker will not be written"
        )


def main() -> None:
    sqlite_path = os.getenv("ADMIN_AUDIT_DB", "/var/lib/potapoff-admin/audit.db")
    # State cutover mutates schema metadata and sequence values. Prefer the
    # dedicated migration identity; the runtime DSN is only a compatibility
    # fallback for older isolated test harnesses.
    dsn = (
        os.getenv("ADMIN_STATE_MIGRATOR_DSN", "").strip()
        or os.getenv("ADMIN_STATE_POSTGRES_DSN", "").strip()
    )
    if not dsn:
        raise SystemExit("ADMIN_STATE_MIGRATOR_DSN is required")
    if not Path(sqlite_path).is_file():
        raise SystemExit(f"SQLite admin state not found: {sqlite_path}")

    # Ensure target schemas exist before the single migration transaction.
    PostgresAuditStore(dsn)
    PostgresControlStore(dsn)
    PostgresLiveAnalysisProfileStore(dsn)
    PostgresAdminSessionStore(dsn, ip_binding=lambda _request: "", ua_binding=lambda _request: "")

    with contextlib.closing(sqlite3.connect(sqlite_path)) as source:
        source.row_factory = sqlite3.Row
        # Pin one consistent SQLite read snapshot across every table. The deploy
        # also stops the legacy Admin writer before this process starts.
        source.execute("BEGIN")
        # Verify the expected source schema before anything else: extra
        # columns would be silently dropped by the fixed SELECT lists.
        # Legacy databases may predate some stores; absence is legal and is
        # reported in the fingerprint, not an error.
        for table in EXPECTED_TABLE_COLUMNS:
            if _table_exists(source, table):
                _assert_expected_columns(source, table)
        source_fingerprint = _sqlite_state_fingerprint(source)
        with psycopg.connect(dsn, row_factory=dict_row, connect_timeout=5) as target, target.cursor() as cur:
            cur.execute(
                """CREATE TABLE IF NOT EXISTS admin_state_migrations(
                    migration_key TEXT PRIMARY KEY,
                    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    source_fingerprint TEXT
                )"""
            )
            cur.execute(
                "ALTER TABLE admin_state_migrations "
                "ADD COLUMN IF NOT EXISTS source_fingerprint TEXT"
            )
            # Freeze all target writers while checking key collisions and copying
            # the SQLite snapshot. This is a one-time cutover, not a merge tool.
            cur.execute(
                "LOCK TABLE feature_flags, alerts, analysis_parameter_overrides, "
                "admin_audit, revoked_admin_sessions, admin_state_migrations "
                "IN SHARE ROW EXCLUSIVE MODE"
            )
            cur.execute(
                "REVOKE ALL PRIVILEGES ON TABLE admin_state_migrations FROM PUBLIC"
            )
            app_user = os.getenv("ADMIN_STATE_APP_USER", "potapoff_admin_app").strip()
            if app_user:
                cur.execute("SELECT 1 FROM pg_roles WHERE rolname=%s", (app_user,))
                if cur.fetchone():
                    cur.execute(
                        sql.SQL(
                            "REVOKE ALL PRIVILEGES ON TABLE admin_state_migrations FROM {}"
                        ).format(sql.Identifier(app_user))
                    )
            cur.execute(
                "SELECT source_fingerprint FROM admin_state_migrations WHERE migration_key=%s",
                (MIGRATION_KEY,),
            )
            previous = cur.fetchone()
            if previous:
                previous_fingerprint = previous["source_fingerprint"]
                if previous_fingerprint is None:
                    raise SystemExit(
                        "Existing SQLite migration marker lacks a source fingerprint; operator reconciliation required"
                    )
                if previous_fingerprint != source_fingerprint:
                    raise SystemExit(
                        "SQLite admin state changed after PostgreSQL cutover; refusing automatic re-migration"
                    )
                print(f"SKIP {MIGRATION_KEY}: source fingerprint unchanged")
                return

            # Do not let a stale SQLite snapshot replace state already written
            # to PostgreSQL. Existing same-key rows require explicit operator
            # reconciliation, even if they appear superficially identical.
            for table, keys, ordering in (
                ("feature_flags", ("name",), "name"),
                ("alerts", ("id",), "id"),
                ("analysis_parameter_overrides", ("domain", "key"), "domain,key"),
                ("admin_audit", ("id",), "id"),
            ):
                _assert_no_target_key_conflicts(cur, source, table, keys, ordering)

            counts: dict[str, int] = {}

            if _table_exists(source, "feature_flags"):
                rows = source.execute("SELECT name,enabled,description,updated_by,updated_at FROM feature_flags").fetchall()
                for row in rows:
                    cur.execute(
                        """INSERT INTO feature_flags(name,enabled,description,updated_by,updated_at)
                           VALUES(%s,%s,%s,%s,%s)
                           ON CONFLICT(name) DO NOTHING""",
                        (row["name"], bool(row["enabled"]), row["description"], row["updated_by"], row["updated_at"]),
                    )
                counts["feature_flags"] = len(rows)
                _assert_keys_migrated(cur, "feature_flags", "name", [row["name"] for row in rows])

            if _table_exists(source, "alerts"):
                rows = source.execute("SELECT * FROM alerts ORDER BY id").fetchall()
                for row in rows:
                    cur.execute(
                        """INSERT INTO alerts(id,level,title,message,source,status,created_at,acknowledged_at,acknowledged_by)
                           VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)
                           ON CONFLICT(id) DO NOTHING""",
                        tuple(row[key] for key in ("id", "level", "title", "message", "source", "status", "created_at", "acknowledged_at", "acknowledged_by")),
                    )
                cur.execute("SELECT setval(pg_get_serial_sequence('alerts','id'), COALESCE(MAX(id),1), COUNT(*)>0) FROM alerts")
                counts["alerts"] = len(rows)
                _assert_keys_migrated(cur, "alerts", "id", [row["id"] for row in rows])

            if _table_exists(source, "analysis_parameter_overrides"):
                rows = source.execute("SELECT * FROM analysis_parameter_overrides").fetchall()
                columns = (
                    "domain", "key", "enabled", "threshold", "label", "source", "value_type", "scale",
                    "description", "custom", "deleted", "updated_by", "updated_at",
                )
                for row in rows:
                    cur.execute(
                        """INSERT INTO analysis_parameter_overrides(
                             domain,key,enabled,threshold,label,source,value_type,scale,description,custom,deleted,updated_by,updated_at
                           ) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                           ON CONFLICT(domain,key) DO NOTHING""",
                        tuple(row[key] for key in columns),
                    )
                counts["analysis_parameter_overrides"] = len(rows)
                _assert_keys_migrated(
                    cur, "analysis_parameter_overrides", "key",
                    [row["key"] for row in rows],
                )

            if _table_exists(source, "admin_audit"):
                last_id = 0
                migrated = 0
                audit_ids: list[int] = []
                while True:
                    rows = source.execute(
                        """SELECT id,created_at,username,ip_address,action,resource,success,details_json
                           FROM admin_audit WHERE id>? ORDER BY id LIMIT 1000""",
                        (last_id,),
                    ).fetchall()
                    if not rows:
                        break
                    for row in rows:
                        cur.execute(
                            """INSERT INTO admin_audit(id,created_at,username,ip_address,action,resource,success,details_json)
                               VALUES(%s,%s,%s,%s,%s,%s,%s,%s::jsonb)
                               ON CONFLICT(id) DO NOTHING""",
                            (row["id"], row["created_at"], row["username"], row["ip_address"], row["action"], row["resource"], bool(row["success"]), _json_object(row["details_json"], row["id"])),
                        )
                    last_id = int(rows[-1]["id"])
                    migrated += len(rows)
                    audit_ids.extend(int(row["id"]) for row in rows)
                cur.execute("SELECT setval(pg_get_serial_sequence('admin_audit','id'), COALESCE(MAX(id),1), COUNT(*)>0) FROM admin_audit")
                counts["admin_audit"] = migrated
                _assert_keys_migrated(cur, "admin_audit", "id", audit_ids)

            # Preserve revocation replay protection across the backend cutover.
            if _table_exists(source, "revoked_admin_sessions"):
                rows = source.execute("SELECT nonce,expires_at,revoked_at FROM revoked_admin_sessions").fetchall()
                for row in rows:
                    cur.execute(
                        """INSERT INTO revoked_admin_sessions(nonce,expires_at,revoked_at)
                           VALUES(%s,%s,%s)
                           ON CONFLICT(nonce) DO UPDATE SET expires_at=GREATEST(revoked_admin_sessions.expires_at,EXCLUDED.expires_at),
                             revoked_at=GREATEST(revoked_admin_sessions.revoked_at,EXCLUDED.revoked_at)""",
                        (row["nonce"], int(row["expires_at"]), row["revoked_at"]),
                    )
                counts["revoked_admin_sessions"] = len(rows)
                _assert_keys_migrated(cur, "revoked_admin_sessions", "nonce", [row["nonce"] for row in rows])

            cur.execute(
                "INSERT INTO admin_state_migrations(migration_key,source_fingerprint) "
                "VALUES(%s,%s) ON CONFLICT(migration_key) DO NOTHING",
                (MIGRATION_KEY, source_fingerprint),
            )

    print("MIGRATION_OK " + " ".join(f"{name}={count}" for name, count in sorted(counts.items())))
    print("Active security sessions were intentionally not migrated; MFA/re-auth will be requested again.")


if __name__ == "__main__":
    main()
