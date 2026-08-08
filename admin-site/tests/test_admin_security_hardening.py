import contextlib
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
import sys

ADMIN_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ADMIN_ROOT))

from fastapi.testclient import TestClient

from app.auth import verify_password


class AdminSecurityHardeningTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.product_db = root / "product.db"
        with contextlib.closing(sqlite3.connect(self.product_db)) as db:
            db.execute("CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, created_at TEXT)")
            db.execute("INSERT INTO users(username,created_at) VALUES(?,?)", ("<img src=x onerror=alert(1)>", "2026-08-08T00:00:00Z"))
            db.commit()
        sources = root / "sources.json"
        sources.write_text(json.dumps([{"id":"test","label":"Test","kind":"sqlite","dsn":str(self.product_db),"role":"core"}]))
        logs = root / "logs.json"
        log_file = root / "service.log"
        log_file.write_text("<script>alert('xss')</script>\n", encoding="utf-8")
        logs.write_text(json.dumps([{"id":"service","label":"Service","path":str(log_file)}]))
        self.old_env = os.environ.copy()
        os.environ.update({
            "ADMIN_SESSION_SECRET":"s"*64,
            "ADMIN_PASSWORD":"correct-password",
            "ADMIN_USERNAME":"admin",
            "ADMIN_SECURE_COOKIE":"false",
            "ADMIN_ENVIRONMENT":"test",
            "ADMIN_AUDIT_DB":str(root/"control.db"),
            "ADMIN_SOURCES_FILE":str(sources),
            "ADMIN_LOGS_FILE":str(logs),
        })
        from app.main import create_app
        self.client = TestClient(create_app())

    def tearDown(self):
        self.client.close()
        os.environ.clear(); os.environ.update(self.old_env)
        self.tmp.cleanup()

    def login(self):
        response = self.client.post("/api/login", json={"username":"admin","password":"correct-password"})
        self.assertEqual(response.status_code, 200)
        return self.client.cookies.get("potapoff_admin_session")

    def test_logout_revokes_stolen_cookie_server_side(self):
        stolen = self.login()
        self.assertTrue(stolen)
        self.assertEqual(self.client.get("/api/me").status_code, 200)
        self.assertEqual(self.client.post("/api/logout").status_code, 200)
        attacker = TestClient(self.client.app)
        try:
            attacker.cookies.set("potapoff_admin_session", stolen)
            self.assertEqual(attacker.get("/api/me").status_code, 401)
            self.assertEqual(attacker.get("/api/overview").status_code, 401)
        finally:
            attacker.close()

    def test_revoked_session_persists_in_sqlite(self):
        stolen = self.login()
        self.assertEqual(self.client.post("/api/logout").status_code, 200)
        with contextlib.closing(sqlite3.connect(os.environ["ADMIN_AUDIT_DB"])) as db:
            count = db.execute("SELECT COUNT(*) FROM revoked_admin_sessions").fetchone()[0]
            self.assertGreaterEqual(count, 1)
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        attacker = TestClient(self.client.app)
        try:
            attacker.cookies.set("potapoff_admin_session", stolen)
            self.assertEqual(attacker.get("/api/me").status_code, 401)
        finally:
            attacker.close()

    def test_hostile_scrypt_work_factor_is_rejected_without_running_it(self):
        hostile = "scrypt$1073741824$8$1$YWJjZGVmZ2hpamtsbW5vcA$" + ("QQ" * 32)
        self.assertFalse(verify_password("password", hostile))
        hostile_r = "scrypt$16384$999999$1$YWJjZGVmZ2hpamtsbW5vcA$" + ("QQ" * 32)
        self.assertFalse(verify_password("password", hostile_r))

    def test_untrusted_database_and_log_html_is_returned_as_data(self):
        self.login()
        user = self.client.get("/api/sources/test/tables/users").json()["rows"][0]
        self.assertIn("<img", user["username"])
        log = self.client.get("/api/logs?log_id=service").json()["log"]["lines"][0]
        self.assertIn("<script>", log)
        # API deliberately returns raw data; the browser layer must escape it before innerHTML.
        app_js = (ADMIN_ROOT / "app" / "static" / "app.js").read_text(encoding="utf-8")
        self.assertIn("function escapeHtml", app_js)
        self.assertIn("escapeHtml(data.log?.lines?.join", app_js)
        self.assertIn("function cell(value)", app_js)
        self.assertIn("escapeHtml(text", app_js)

    def test_login_form_preserves_invalid_credentials_message(self):
        response = self.client.post("/api/login", json={"username":"admin","password":"wrong"})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["detail"], "Invalid credentials")
        app_js = (ADMIN_ROOT / "app" / "static" / "app.js").read_text(encoding="utf-8")
        self.assertIn("new URL(path, window.location.origin).pathname", app_js)
        self.assertIn('pathname === "/api/login" ? detail : "Требуется вход"', app_js)


if __name__ == "__main__":
    unittest.main()
