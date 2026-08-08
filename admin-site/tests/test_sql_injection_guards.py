from __future__ import annotations

import contextlib
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
import sys

from fastapi.testclient import TestClient

ADMIN_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ADMIN_ROOT))


class SqlInjectionGuardTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.product_db = root / "product.db"
        self.control_db = root / "control.db"
        with contextlib.closing(sqlite3.connect(self.product_db)) as db:
            db.execute("CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, wallet TEXT, created_at TEXT)")
            db.execute(
                "INSERT INTO users(username,wallet,created_at) VALUES(?,?,?)",
                ("alice", "WalletSafe111", "2026-08-08T00:00:00Z"),
            )
            db.execute("CREATE TABLE jobs(id INTEGER PRIMARY KEY, status TEXT, payload TEXT)")
            db.execute("INSERT INTO jobs(status,payload) VALUES(?,?)", ("queued", "safe"))
            db.commit()

        sources = root / "sources.json"
        sources.write_text(json.dumps([
            {"id": "test", "label": "Test DB", "kind": "sqlite", "dsn": str(self.product_db), "role": "core"}
        ]), encoding="utf-8")
        logs = root / "logs.json"
        logs.write_text("[]", encoding="utf-8")

        self.old_env = os.environ.copy()
        os.environ.update({
            "ADMIN_SESSION_SECRET": "x" * 64,
            "ADMIN_PASSWORD": "correct-password",
            "ADMIN_USERNAME": "admin",
            "ADMIN_SECURE_COOKIE": "false",
            "ADMIN_ENVIRONMENT": "test",
            "ADMIN_AUDIT_DB": str(self.control_db),
            "ADMIN_SOURCES_FILE": str(sources),
            "ADMIN_LOGS_FILE": str(logs),
            "SOLANA_RPC_URL": "http://localhost:8899",
        })
        from app.main_admin import create_app
        self.client = TestClient(create_app())
        response = self.client.post("/api/login", json={"username": "admin", "password": "correct-password"})
        self.assertEqual(response.status_code, 200)

    def tearDown(self):
        self.client.close()
        os.environ.clear()
        os.environ.update(self.old_env)
        self.tmp.cleanup()

    def assert_product_db_intact(self):
        with contextlib.closing(sqlite3.connect(self.product_db)) as db:
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            names = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertIn("users", names)
            self.assertIn("jobs", names)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM users").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT username FROM users").fetchone()[0], "alice")

    def assert_control_db_intact(self):
        with contextlib.closing(sqlite3.connect(self.control_db)) as db:
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            names = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertIn("admin_audit", names)
            self.assertIn("feature_flags", names)
            self.assertIn("alerts", names)
            self.assertIn("analysis_parameter_overrides", names)

    def test_search_payload_is_bound_as_data_not_sql(self):
        payloads = [
            "' OR 1=1 --",
            "%' UNION SELECT 1,2,3,4 --",
            "'; DROP TABLE users; --",
            '" OR "1"="1',
        ]
        for payload in payloads:
            with self.subTest(payload=payload):
                response = self.client.get("/api/sources/test/tables/users", params={"search": payload})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["total"], 0)
                self.assert_product_db_intact()

    def test_table_identifier_payload_is_rejected_and_cannot_execute(self):
        payloads = [
            'users"; DROP TABLE users;--',
            "users;DROP TABLE users;--",
            "users UNION SELECT * FROM jobs",
            "../users",
        ]
        for payload in payloads:
            with self.subTest(payload=payload):
                response = self.client.get(f"/api/sources/test/tables/{payload}")
                self.assertIn(response.status_code, (404, 503))
                self.assert_product_db_intact()

    def test_sort_identifier_payload_never_becomes_sql(self):
        payloads = [
            'username"; DROP TABLE users;--',
            "username DESC; DROP TABLE users;--",
            "(SELECT sqlite_version())",
        ]
        for payload in payloads:
            with self.subTest(payload=payload):
                response = self.client.get("/api/sources/test/tables/users", params={"sort": payload, "order": "asc"})
                self.assertEqual(response.status_code, 200)
                # Invalid sort values must fall back to a real column, never be interpolated.
                self.assertIn(response.json()["sort"], {"id", "username", "wallet", "created_at"})
                self.assert_product_db_intact()

    def test_source_identifier_payload_is_registry_lookup_only(self):
        response = self.client.get("/api/sources/test%27%20OR%201%3D1--/tables")
        self.assertEqual(response.status_code, 404)
        self.assert_product_db_intact()

    def test_control_store_payloads_are_parameterized(self):
        flag_payload = "x'); DROP TABLE feature_flags;--"
        # Feature-flag names are additionally schema-validated before SQL.
        response = self.client.put(
            "/api/feature-flags/safe",
            json={"name": flag_payload, "enabled": True, "description": "'; DROP TABLE alerts; --"},
        )
        self.assertIn(response.status_code, (400, 422))

        alert = self.client.post(
            "/api/alerts",
            json={
                "level": "warning",
                "title": "SQLi probe",
                "message": "'); DROP TABLE alerts; --",
                "source": "x' OR 1=1 --",
            },
        )
        self.assertEqual(alert.status_code, 200)
        filtered = self.client.get("/api/alerts", params={"status": "' OR 1=1 --"})
        self.assertEqual(filtered.status_code, 200)
        self.assertEqual(filtered.json()["rows"], [])
        self.assert_control_db_intact()

    def test_analysis_keys_sources_and_thresholds_cannot_inject_sql(self):
        malicious_key = "x'); DROP TABLE analysis_parameter_overrides;--"
        create = self.client.post(
            "/api/analysis-profiles/wallet",
            json={
                "key": malicious_key,
                "label": "probe",
                "source": "metrics.value",
                "value_type": "number",
                "scale": "raw",
                "threshold": ">= 1",
                "enabled": True,
                "description": "probe",
            },
        )
        self.assertEqual(create.status_code, 422)

        malicious_source = self.client.post(
            "/api/analysis-profiles/wallet",
            json={
                "key": "safe_probe",
                "label": "probe",
                "source": "metrics.value); DROP TABLE analysis_parameter_overrides;--",
                "value_type": "number",
                "scale": "raw",
                "threshold": ">= 1",
                "enabled": True,
                "description": "probe",
            },
        )
        self.assertEqual(malicious_source.status_code, 422)

        threshold = self.client.put(
            "/api/analysis-profiles/wallet/migration_rate",
            json={"enabled": True, "threshold": ">= 1; DROP TABLE analysis_parameter_overrides;--"},
        )
        self.assertEqual(threshold.status_code, 422)
        self.assert_control_db_intact()


if __name__ == "__main__":
    unittest.main()
