from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .analysis_editor import LiveAnalysisProfileStore
from .postgres_pool import pooled_connection


_SCHEMA_LOCK_ID = 726824730


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _lock_schema(cur) -> None:
    cur.execute("SELECT pg_advisory_xact_lock(%s)", (_SCHEMA_LOCK_ID,))


class _PgCompatConnection:
    """Small DB-API compatibility layer for the existing analysis store SQL."""

    def __init__(self, dsn: str, pool: ConnectionPool | None = None) -> None:
        self._context = pooled_connection(pool, dsn, row_factory=dict_row, connect_timeout=5)
        self._db = self._context.__enter__()
        self._closed = False

    def execute(self, query: str, params: Any = None):
        sql = query.replace("?", "%s")
        cur = self._db.cursor()
        cur.execute(sql, params or ())
        return cur

    def commit(self) -> None:
        self._db.commit()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._context.__exit__(None, None, None)


class PostgresAuditStore:
    def __init__(self, dsn: str, *, pool: ConnectionPool | None = None) -> None:
        self.dsn = dsn
        self.pool = pool
        with self._connect() as db, db.cursor() as cur:
            _lock_schema(cur)
            cur.execute(
                """CREATE TABLE IF NOT EXISTS admin_audit(
                    id BIGSERIAL PRIMARY KEY,
                    created_at TIMESTAMPTZ NOT NULL,
                    username TEXT,
                    ip_address TEXT,
                    action TEXT NOT NULL,
                    resource TEXT,
                    success BOOLEAN NOT NULL,
                    details_json JSONB NOT NULL DEFAULT '{}'::jsonb
                )"""
            )
            cur.execute("CREATE INDEX IF NOT EXISTS ix_admin_audit_created ON admin_audit(created_at DESC)")
            cur.execute("CREATE INDEX IF NOT EXISTS ix_admin_audit_action_created ON admin_audit(action, created_at DESC)")
            cur.execute(
                """CREATE TABLE IF NOT EXISTS revoked_admin_sessions(
                    nonce TEXT PRIMARY KEY,
                    expires_at BIGINT NOT NULL,
                    revoked_at TIMESTAMPTZ NOT NULL
                )"""
            )
            cur.execute("CREATE INDEX IF NOT EXISTS ix_revoked_admin_sessions_expires ON revoked_admin_sessions(expires_at)")

    def _connect(self):
        return pooled_connection(self.pool, self.dsn, row_factory=dict_row, connect_timeout=5)

    def record(self, *, action: str, success: bool, username: str | None = None, ip_address: str | None = None, resource: str | None = None, details: dict[str, Any] | None = None) -> None:
        with self._connect() as db, db.cursor() as cur:
            cur.execute(
                """INSERT INTO admin_audit(created_at,username,ip_address,action,resource,success,details_json)
                   VALUES(%s,%s,%s,%s,%s,%s,%s::jsonb)""",
                (_utcnow(), username, ip_address, action, resource, bool(success), json.dumps(details or {}, ensure_ascii=False, default=str)),
            )

    def revoke_session(self, nonce: str, expires_at: int) -> None:
        import time
        now = int(time.time())
        if not nonce or expires_at <= now:
            return
        with self._connect() as db, db.cursor() as cur:
            cur.execute("DELETE FROM revoked_admin_sessions WHERE expires_at<=%s", (now,))
            cur.execute(
                """INSERT INTO revoked_admin_sessions(nonce,expires_at,revoked_at) VALUES(%s,%s,%s)
                   ON CONFLICT(nonce) DO UPDATE SET expires_at=EXCLUDED.expires_at, revoked_at=EXCLUDED.revoked_at""",
                (nonce, int(expires_at), _utcnow()),
            )

    def is_session_revoked(self, nonce: str) -> bool:
        import time
        if not nonce:
            return True
        with self._connect() as db, db.cursor() as cur:
            cur.execute("SELECT 1 FROM revoked_admin_sessions WHERE nonce=%s AND expires_at>%s LIMIT 1", (nonce, int(time.time())))
            return cur.fetchone() is not None

    def list(self, limit: int = 200) -> list[dict[str, Any]]:
        with self._connect() as db, db.cursor() as cur:
            cur.execute(
                """SELECT id,created_at,username,ip_address,action,resource,success,details_json
                   FROM admin_audit ORDER BY id DESC LIMIT %s""",
                (max(1, min(limit, 1000)),),
            )
            rows = cur.fetchall()
        output = []
        for row in rows:
            item = dict(row)
            item["created_at"] = item["created_at"].isoformat() if item.get("created_at") else None
            item["success"] = bool(item["success"])
            details = item.pop("details_json", {})
            item["details"] = details if isinstance(details, dict) else {}
            output.append(item)
        return output

    def ready(self) -> bool:
        try:
            with self._connect() as db, db.cursor() as cur:
                cur.execute("SELECT 1")
                return cur.fetchone() is not None
        except psycopg.Error:
            return False


class PostgresControlStore:
    def __init__(self, dsn: str, *, pool: ConnectionPool | None = None) -> None:
        self.dsn = dsn
        self.pool = pool
        with self._connect() as db, db.cursor() as cur:
            _lock_schema(cur)
            cur.execute(
                """CREATE TABLE IF NOT EXISTS feature_flags(
                    name TEXT PRIMARY KEY,
                    enabled BOOLEAN NOT NULL DEFAULT FALSE,
                    description TEXT NOT NULL DEFAULT '',
                    updated_by TEXT,
                    updated_at TIMESTAMPTZ NOT NULL
                )"""
            )
            cur.execute(
                """CREATE TABLE IF NOT EXISTS alerts(
                    id BIGSERIAL PRIMARY KEY,
                    level TEXT NOT NULL,
                    title TEXT NOT NULL,
                    message TEXT NOT NULL,
                    source TEXT NOT NULL DEFAULT 'control-center',
                    status TEXT NOT NULL DEFAULT 'open',
                    created_at TIMESTAMPTZ NOT NULL,
                    acknowledged_at TIMESTAMPTZ,
                    acknowledged_by TEXT
                )"""
            )
            cur.execute("CREATE INDEX IF NOT EXISTS ix_alerts_status_created ON alerts(status, created_at DESC)")
            cur.execute("CREATE INDEX IF NOT EXISTS ix_alerts_created ON alerts(created_at DESC)")

    def _connect(self):
        return pooled_connection(self.pool, self.dsn, row_factory=dict_row, connect_timeout=5)

    @staticmethod
    def _serialize(row: dict[str, Any]) -> dict[str, Any]:
        item = dict(row)
        for key in ("updated_at", "created_at", "acknowledged_at"):
            if item.get(key) is not None and hasattr(item[key], "isoformat"):
                item[key] = item[key].isoformat()
        if "enabled" in item:
            item["enabled"] = bool(item["enabled"])
        return item

    def flags(self) -> list[dict[str, Any]]:
        with self._connect() as db, db.cursor() as cur:
            cur.execute("SELECT name,enabled,description,updated_by,updated_at FROM feature_flags ORDER BY name")
            return [self._serialize(row) for row in cur.fetchall()]

    def set_flag(self, name: str, enabled: bool, description: str, username: str) -> dict[str, Any]:
        now = _utcnow()
        with self._connect() as db, db.cursor() as cur:
            cur.execute(
                """INSERT INTO feature_flags(name,enabled,description,updated_by,updated_at)
                   VALUES(%s,%s,%s,%s,%s)
                   ON CONFLICT(name) DO UPDATE SET enabled=EXCLUDED.enabled,description=EXCLUDED.description,
                     updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at""",
                (name, bool(enabled), description, username, now),
            )
        return {"name": name, "enabled": bool(enabled), "description": description, "updated_by": username, "updated_at": now.isoformat()}

    def alerts(self, status: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
        sql = "SELECT * FROM alerts"
        params: list[Any] = []
        if status:
            sql += " WHERE status=%s"
            params.append(status)
        sql += " ORDER BY id DESC LIMIT %s"
        params.append(max(1, min(limit, 1000)))
        with self._connect() as db, db.cursor() as cur:
            cur.execute(sql, params)
            return [self._serialize(row) for row in cur.fetchall()]

    def create_alert(self, level: str, title: str, message: str, source: str) -> dict[str, Any]:
        now = _utcnow()
        with self._connect() as db, db.cursor() as cur:
            cur.execute(
                """INSERT INTO alerts(level,title,message,source,status,created_at)
                   VALUES(%s,%s,%s,%s,'open',%s) RETURNING id""",
                (level, title, message, source, now),
            )
            alert_id = int(cur.fetchone()["id"])
        return {"id": alert_id, "level": level, "title": title, "message": message, "source": source, "status": "open", "created_at": now.isoformat()}

    def acknowledge(self, alert_id: int, username: str) -> bool:
        with self._connect() as db, db.cursor() as cur:
            cur.execute(
                """UPDATE alerts SET status='acknowledged',acknowledged_at=%s,acknowledged_by=%s
                   WHERE id=%s AND status='open'""",
                (_utcnow(), username, alert_id),
            )
            return cur.rowcount == 1


class PostgresLiveAnalysisProfileStore(LiveAnalysisProfileStore):
    def __init__(self, dsn: str, *, pool: ConnectionPool | None = None) -> None:
        self.path = dsn
        self.dsn = dsn
        self.pool = pool
        with self._connect_raw() as db, db.cursor() as cur:
            _lock_schema(cur)
            cur.execute(
                """CREATE TABLE IF NOT EXISTS analysis_parameter_overrides(
                    domain TEXT NOT NULL,
                    key TEXT NOT NULL,
                    enabled INTEGER NOT NULL,
                    threshold TEXT NOT NULL DEFAULT '',
                    label TEXT,
                    source TEXT,
                    value_type TEXT,
                    scale TEXT,
                    description TEXT,
                    custom INTEGER NOT NULL DEFAULT 0,
                    deleted INTEGER NOT NULL DEFAULT 0,
                    updated_by TEXT,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY(domain,key)
                )"""
            )
            cur.execute("CREATE INDEX IF NOT EXISTS ix_analysis_overrides_domain ON analysis_parameter_overrides(domain, deleted, enabled)")
            cur.execute("CREATE INDEX IF NOT EXISTS ix_analysis_overrides_active ON analysis_parameter_overrides(domain, key) WHERE deleted=0")

    def _connect_raw(self):
        return pooled_connection(self.pool, self.dsn, row_factory=dict_row, connect_timeout=5)

    def connect(self) -> _PgCompatConnection:
        return _PgCompatConnection(self.dsn, self.pool)
