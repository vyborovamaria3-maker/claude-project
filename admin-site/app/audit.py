from __future__ import annotations

import contextlib

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


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
