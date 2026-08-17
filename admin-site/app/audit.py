from __future__ import annotations

import contextlib
from datetime import datetime, timezone
from typing import Any

import json
import sqlite3
import threading
import time
from pathlib import Path


class AuditStore:
    def __init__(self, path: str) -> None:
        self.path = path
        self._lock = threading.Lock()
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with contextlib.closing(self._connect()) as db:
            db.execute(
                """
                CREATE TABLE IF NOT EXISTS admin_audit (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    created_at TEXT NOT NULL,
                    username TEXT,
                    ip_address TEXT,
                    action TEXT NOT NULL,
                    resource TEXT,
                    success INTEGER NOT NULL,
                    details_json TEXT
                )
                """
            )
            db.execute("CREATE INDEX IF NOT EXISTS ix_admin_audit_created ON admin_audit(created_at DESC)")
            db.execute(
                """
                CREATE TABLE IF NOT EXISTS revoked_admin_sessions (
                    nonce TEXT PRIMARY KEY,
                    expires_at INTEGER NOT NULL,
                    revoked_at TEXT NOT NULL
                )
                """
            )
            db.execute("CREATE INDEX IF NOT EXISTS ix_revoked_admin_sessions_expires ON revoked_admin_sessions(expires_at)")
            db.commit()

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        return db

    def record(
        self,
        *,
        action: str,
        success: bool,
        username: str | None = None,
        ip_address: str | None = None,
        resource: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        with self._lock, contextlib.closing(self._connect()) as db:
            db.execute(
                "INSERT INTO admin_audit(created_at, username, ip_address, action, resource, success, details_json) VALUES(?,?,?,?,?,?,?)",
                (
                    datetime.now(timezone.utc).isoformat(),
                    username,
                    ip_address,
                    action,
                    resource,
                    1 if success else 0,
                    json.dumps(details or {}, ensure_ascii=False, default=str),
                ),
            )
            db.commit()

    def revoke_session(self, nonce: str, expires_at: int) -> None:
        if not nonce:
            raise ValueError("Session nonce is required")
        now = int(time.time())
        if expires_at <= now:
            return
        with self._lock, contextlib.closing(self._connect()) as db:
            db.execute("DELETE FROM revoked_admin_sessions WHERE expires_at<=?", (now,))
            db.execute(
                "INSERT INTO revoked_admin_sessions(nonce, expires_at, revoked_at) VALUES(?,?,?) "
                "ON CONFLICT(nonce) DO UPDATE SET expires_at=excluded.expires_at, revoked_at=excluded.revoked_at",
                (nonce, int(expires_at), datetime.now(timezone.utc).isoformat()),
            )
            db.commit()

    def is_session_revoked(self, nonce: str) -> bool:
        if not nonce:
            return True
        now = int(time.time())
        # Hot path: this check runs for every authenticated API request. Keep it
        # read-only; expired rows are cleaned opportunistically by revoke_session().
        with contextlib.closing(self._connect()) as db:
            row = db.execute(
                "SELECT 1 FROM revoked_admin_sessions WHERE nonce=? AND expires_at>? LIMIT 1",
                (nonce, now),
            ).fetchone()
            return row is not None

    def list(self, limit: int = 200) -> list[dict[str, Any]]:
        with contextlib.closing(self._connect()) as db:
            rows = db.execute(
                "SELECT id, created_at, username, ip_address, action, resource, success, details_json FROM admin_audit ORDER BY id DESC LIMIT ?",
                (max(1, min(limit, 1000)),),
            ).fetchall()
        output: list[dict[str, Any]] = []
        for row in rows:
            item = dict(row)
            item["success"] = bool(item["success"])
            try:
                item["details"] = json.loads(item.pop("details_json") or "{}")
            except json.JSONDecodeError:
                item["details"] = {}
            output.append(item)
        return output
