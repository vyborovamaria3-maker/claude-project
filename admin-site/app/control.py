from __future__ import annotations

import contextlib

import json
import os
import platform
import shutil
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class ControlStore:
    def __init__(self, path: str) -> None:
        self.path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with contextlib.closing(self.connect()) as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS feature_flags(
                  name TEXT PRIMARY KEY,
                  enabled INTEGER NOT NULL DEFAULT 0,
                  description TEXT NOT NULL DEFAULT '',
                  updated_by TEXT,
                  updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS alerts(
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  level TEXT NOT NULL,
                  title TEXT NOT NULL,
                  message TEXT NOT NULL,
                  source TEXT NOT NULL DEFAULT 'control-center',
                  status TEXT NOT NULL DEFAULT 'open',
                  created_at TEXT NOT NULL,
                  acknowledged_at TEXT,
                  acknowledged_by TEXT
                );
                CREATE INDEX IF NOT EXISTS ix_alerts_status_created ON alerts(status, created_at DESC);
                """
            )
            db.commit()

    def connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        return db

    def flags(self) -> list[dict[str, Any]]:
        with contextlib.closing(self.connect()) as db:
            return [dict(row) | {"enabled": bool(row["enabled"])} for row in db.execute(
                "SELECT name, enabled, description, updated_by, updated_at FROM feature_flags ORDER BY name"
            )]

    def set_flag(self, name: str, enabled: bool, description: str, username: str) -> dict[str, Any]:
        now = datetime.now(timezone.utc).isoformat()
        with contextlib.closing(self.connect()) as db:
            db.execute(
                """INSERT INTO feature_flags(name, enabled, description, updated_by, updated_at)
                   VALUES(?,?,?,?,?)
                   ON CONFLICT(name) DO UPDATE SET enabled=excluded.enabled,
                     description=excluded.description, updated_by=excluded.updated_by, updated_at=excluded.updated_at""",
                (name, 1 if enabled else 0, description, username, now),
            )
            db.commit()
        return {"name": name, "enabled": enabled, "description": description, "updated_by": username, "updated_at": now}

    def alerts(self, status: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
        query = "SELECT * FROM alerts"
        params: list[Any] = []
        if status:
            query += " WHERE status=?"
            params.append(status)
        query += " ORDER BY id DESC LIMIT ?"
        params.append(max(1, min(limit, 1000)))
        with contextlib.closing(self.connect()) as db:
            return [dict(row) for row in db.execute(query, params)]

    def create_alert(self, level: str, title: str, message: str, source: str) -> dict[str, Any]:
        now = datetime.now(timezone.utc).isoformat()
        with contextlib.closing(self.connect()) as db:
            cur = db.execute(
                "INSERT INTO alerts(level,title,message,source,status,created_at) VALUES(?,?,?,?,?,?)",
                (level, title, message, source, "open", now),
            )
            db.commit()
            alert_id = cur.lastrowid
        return {"id": alert_id, "level": level, "title": title, "message": message, "source": source, "status": "open", "created_at": now}

    def acknowledge(self, alert_id: int, username: str) -> bool:
        now = datetime.now(timezone.utc).isoformat()
        with contextlib.closing(self.connect()) as db:
            cur = db.execute(
                "UPDATE alerts SET status='acknowledged', acknowledged_at=?, acknowledged_by=? WHERE id=? AND status='open'",
                (now, username, alert_id),
            )
            db.commit()
            return cur.rowcount == 1


def runtime_metrics(started_at: float) -> dict[str, Any]:
    load = os.getloadavg() if hasattr(os, "getloadavg") else (0.0, 0.0, 0.0)
    disk = shutil.disk_usage("/")
    total = disk.total
    free = disk.free
    return {
        "hostname": platform.node(),
        "python": platform.python_version(),
        "platform": platform.platform(),
        "uptime_seconds": int(time.monotonic() - started_at),
        "load_average": list(load),
        "disk": {"total_bytes": total, "free_bytes": free, "used_percent": round((1 - free / total) * 100, 2) if total else 0},
        "time": datetime.now(timezone.utc).isoformat(),
    }


def inventory(root: Path) -> dict[str, Any]:
    services: list[dict[str, Any]] = []
    manifests = {"package.json", "pyproject.toml", "requirements.txt", "docker-compose.yml", "docker-compose.prod.yml"}
    for path in root.rglob("*"):
        if not path.is_file() or path.name not in manifests:
            continue
        rel = path.parent.relative_to(root)
        services.append({"path": str(rel), "manifest": path.name, "size": path.stat().st_size})
    services.sort(key=lambda item: (item["path"], item["manifest"]))
    return {"root": str(root), "service_manifests": services, "count": len(services)}
