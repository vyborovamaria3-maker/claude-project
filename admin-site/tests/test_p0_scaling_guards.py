from __future__ import annotations

import contextlib
import csv
import io
import sqlite3
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path

from app.audit import AuditStore
from app.config import DataSourceConfig
from app.database import DataSource


class P0ScalingGuardsTest(unittest.TestCase):
    def test_revoked_session_lookup_does_not_delete_expired_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "admin.db"
            store = AuditStore(str(path))
            now = int(time.time())
            with contextlib.closing(sqlite3.connect(path)) as db:
                db.execute(
                    "INSERT INTO revoked_admin_sessions(nonce, expires_at, revoked_at) VALUES(?,?,?)",
                    ("expired-session", now - 1, datetime.now(timezone.utc).isoformat()),
                )
                db.execute(
                    "INSERT INTO revoked_admin_sessions(nonce, expires_at, revoked_at) VALUES(?,?,?)",
                    ("active-session", now + 600, datetime.now(timezone.utc).isoformat()),
                )
                db.commit()

            self.assertFalse(store.is_session_revoked("expired-session"))
            self.assertTrue(store.is_session_revoked("active-session"))

            with contextlib.closing(sqlite3.connect(path)) as db:
                # Expired rows are cleaned when a new revocation is written, not on
                # every authenticated request.
                count = db.execute(
                    "SELECT COUNT(*) FROM revoked_admin_sessions WHERE nonce='expired-session'"
                ).fetchone()[0]
            self.assertEqual(count, 1)

    def test_csv_export_is_chunked_and_preserves_safety_guards(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "product.db"
            with contextlib.closing(sqlite3.connect(path)) as db:
                db.execute("CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT, password TEXT)")
                rows = [
                    (index, "=SUM(1,1)" if index == 1 else f"item-{index}", f"secret-{index}")
                    for index in range(1, 2502)
                ]
                db.executemany("INSERT INTO items(id,name,password) VALUES(?,?,?)", rows)
                db.commit()

            source = DataSource(
                DataSourceConfig(id="test", label="Test", kind="sqlite", dsn=str(path)),
                show_sensitive=False,
            )
            chunks = list(source.iter_csv("items", limit=2501, batch_size=1000))
            self.assertEqual(len(chunks), 4)  # header + three bounded row batches

            text = "".join(chunks)
            parsed = list(csv.DictReader(io.StringIO(text)))
            self.assertEqual(len(parsed), 2501)
            self.assertEqual(parsed[0]["name"], "'=SUM(1,1)")
            self.assertEqual(parsed[0]["password"], "••••••")
            self.assertNotIn("secret-1", text)

    def test_nginx_has_separate_auth_heavy_and_general_api_limits(self):
        config = (Path(__file__).resolve().parents[1] / "deploy" / "nginx-admin.conf").read_text(encoding="utf-8")
        self.assertIn("zone=admin_auth:10m rate=5r/m", config)
        self.assertIn("zone=admin_heavy:10m rate=30r/m", config)
        self.assertIn("zone=admin_api:10m rate=10r/s", config)
        self.assertIn("location = /api/login", config)
        self.assertIn("location ~ ^/api/(search|graph)$", config)
        self.assertIn("export\\.csv$", config)
        self.assertIn("limit_req_status 429", config)


if __name__ == "__main__":
    unittest.main()
