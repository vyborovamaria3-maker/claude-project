from __future__ import annotations

import contextlib
import json
import os
import sqlite3
import sys
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.postgres_admin_state import PostgresAuditStore, PostgresControlStore, PostgresLiveAnalysisProfileStore
from app.postgres_security_store import PostgresAdminSessionStore


MIGRATION_KEY = "admin-sqlite-to-postgres-v1"


def _table_exists(db: sqlite3.Connection, table: str) -> bool:
    row = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()
    return row is not None


def _json_object(value: str | None) -> str:
    try:
        parsed = json.loads(value or "{}")
    except json.JSONDecodeError:
        parsed = {}
    return json.dumps(parsed if isinstance(parsed, dict) else {}, ensure_ascii=False, default=str)


def main() -> None:
    sqlite_path = os.getenv("ADMIN_AUDIT_DB", "/var/lib/potapoff-admin/audit.db")
    dsn = os.getenv("ADMIN_STATE_POSTGRES_DSN", "").strip()
    if not dsn:
        raise SystemExit("ADMIN_STATE_POSTGRES_DSN is required")
    if not Path(sqlite_path).is_file():
        raise SystemExit(f"SQLite admin state not found: {sqlite_path}")

    # Ensure target schemas exist before the single migration transaction.
    PostgresAuditStore(dsn)
    PostgresControlStore(dsn)
    PostgresLiveAnalysisProfileStore(dsn)
    PostgresAdminSessionStore(dsn, ip_binding=lambda _request: "", ua_binding=lambda _request: "")

    with contextlib.closing(sqlite3.connect(sqlite_path)) as source:
        source.row_factory = sqlite3.Row
        with psycopg.connect(dsn, row_factory=dict_row, connect_timeout=5) as target, target.cursor() as cur:
            cur.execute(
                """CREATE TABLE IF NOT EXISTS admin_state_migrations(
                    migration_key TEXT PRIMARY KEY,
                    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
                )"""
            )
            cur.execute("SELECT 1 FROM admin_state_migrations WHERE migration_key=%s", (MIGRATION_KEY,))
            if cur.fetchone():
                print(f"SKIP {MIGRATION_KEY}: already applied")
                return

            counts: dict[str, int] = {}

            if _table_exists(source, "feature_flags"):
                rows = source.execute("SELECT name,enabled,description,updated_by,updated_at FROM feature_flags").fetchall()
                for row in rows:
                    cur.execute(
                        """INSERT INTO feature_flags(name,enabled,description,updated_by,updated_at)
                           VALUES(%s,%s,%s,%s,%s)
                           ON CONFLICT(name) DO UPDATE SET enabled=EXCLUDED.enabled,description=EXCLUDED.description,
                             updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at""",
                        (row["name"], bool(row["enabled"]), row["description"], row["updated_by"], row["updated_at"]),
                    )
                counts["feature_flags"] = len(rows)

            if _table_exists(source, "alerts"):
                rows = source.execute("SELECT * FROM alerts ORDER BY id").fetchall()
                for row in rows:
                    cur.execute(
                        """INSERT INTO alerts(id,level,title,message,source,status,created_at,acknowledged_at,acknowledged_by)
                           VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)
                           ON CONFLICT(id) DO UPDATE SET level=EXCLUDED.level,title=EXCLUDED.title,message=EXCLUDED.message,
                             source=EXCLUDED.source,status=EXCLUDED.status,created_at=EXCLUDED.created_at,
                             acknowledged_at=EXCLUDED.acknowledged_at,acknowledged_by=EXCLUDED.acknowledged_by""",
                        tuple(row[key] for key in ("id", "level", "title", "message", "source", "status", "created_at", "acknowledged_at", "acknowledged_by")),
                    )
                cur.execute("SELECT setval(pg_get_serial_sequence('alerts','id'), COALESCE(MAX(id),1), COUNT(*)>0) FROM alerts")
                counts["alerts"] = len(rows)

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
                           ON CONFLICT(domain,key) DO UPDATE SET enabled=EXCLUDED.enabled,threshold=EXCLUDED.threshold,
                             label=EXCLUDED.label,source=EXCLUDED.source,value_type=EXCLUDED.value_type,scale=EXCLUDED.scale,
                             description=EXCLUDED.description,custom=EXCLUDED.custom,deleted=EXCLUDED.deleted,
                             updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at""",
                        tuple(row[key] for key in columns),
                    )
                counts["analysis_parameter_overrides"] = len(rows)

            if _table_exists(source, "admin_audit"):
                last_id = 0
                migrated = 0
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
                            (row["id"], row["created_at"], row["username"], row["ip_address"], row["action"], row["resource"], bool(row["success"]), _json_object(row["details_json"])),
                        )
                    last_id = int(rows[-1]["id"])
                    migrated += len(rows)
                cur.execute("SELECT setval(pg_get_serial_sequence('admin_audit','id'), COALESCE(MAX(id),1), COUNT(*)>0) FROM admin_audit")
                counts["admin_audit"] = migrated

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

            cur.execute("INSERT INTO admin_state_migrations(migration_key) VALUES(%s)", (MIGRATION_KEY,))

    print("MIGRATION_OK " + " ".join(f"{name}={count}" for name, count in sorted(counts.items())))
    print("Active security sessions were intentionally not migrated; MFA/re-auth will be requested again.")


if __name__ == "__main__":
    main()
