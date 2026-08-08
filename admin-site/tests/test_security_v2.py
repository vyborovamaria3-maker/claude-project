from __future__ import annotations

import contextlib
import os
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from app.security_v2 import totp_code


class SecurityV2Test(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        (root / "sources.json").write_text("[]", encoding="utf-8")
        (root / "logs.json").write_text("[]", encoding="utf-8")
        self.db = root / "control.db"
        self.secret = "JBSWY3DPEHPK3PXP"
        self.old_env = os.environ.copy()
        os.environ.update({
            "ADMIN_SESSION_SECRET":"s"*64,
            "ADMIN_PASSWORD":"correct-password",
            "ADMIN_USERNAME":"admin",
            "ADMIN_SECURE_COOKIE":"false",
            "ADMIN_ENVIRONMENT":"test",
            "ADMIN_AUDIT_DB":str(self.db),
            "ADMIN_SOURCES_FILE":str(root / "sources.json"),
            "ADMIN_LOGS_FILE":str(root / "logs.json"),
            "SOLANA_RPC_URL":"http://localhost:8899",
            "ADMIN_REQUIRE_MFA":"true",
            "ADMIN_TOTP_SECRET":self.secret,
            "ADMIN_REQUIRE_REAUTH":"true",
            "ADMIN_REAUTH_TTL_SECONDS":"60",
            "ADMIN_IDLE_TIMEOUT_SECONDS":"300",
            "ADMIN_SESSION_BIND_IP":"false",
            "ADMIN_SESSION_BIND_USER_AGENT":"true",
            "ADMIN_REQUIRE_NETWORK_ALLOWLIST":"false",
        })
        from app.main_admin import create_app
        self.client = TestClient(create_app())

    def tearDown(self):
        self.client.close()
        os.environ.clear(); os.environ.update(self.old_env)
        self.tmp.cleanup()

    def login(self):
        r = self.client.post("/api/login", json={"username":"admin","password":"correct-password"})
        self.assertEqual(r.status_code, 200)

    def verify_mfa(self):
        r = self.client.post("/api/security/mfa/verify", json={"code":totp_code(self.secret)})
        self.assertEqual(r.status_code, 200, r.text)

    def test_mfa_blocks_admin_api_until_verified(self):
        self.login()
        blocked = self.client.get("/api/me")
        self.assertEqual(blocked.status_code, 428)
        self.assertEqual(blocked.json()["code"], "mfa_required")
        state = self.client.get("/api/security/session")
        self.assertEqual(state.status_code, 200)
        self.assertTrue(state.json()["mfa_required"])
        self.assertFalse(state.json()["mfa_verified"])
        self.assertEqual(self.client.post("/api/security/mfa/verify", json={"code":"000000"}).status_code, 401)
        self.verify_mfa()
        self.assertEqual(self.client.get("/api/me").status_code, 200)

    def test_mutation_requires_recent_password_and_totp_reauth(self):
        self.login(); self.verify_mfa()
        blocked = self.client.put("/api/feature-flags/security.test", json={"name":"security.test","enabled":True,"description":"test"})
        self.assertEqual(blocked.status_code, 428)
        self.assertEqual(blocked.json()["code"], "reauth_required")
        self.assertEqual(self.client.post("/api/security/reauth", json={"password":"wrong","code":totp_code(self.secret)}).status_code, 401)
        good = self.client.post("/api/security/reauth", json={"password":"correct-password","code":totp_code(self.secret)})
        self.assertEqual(good.status_code, 200, good.text)
        allowed = self.client.put("/api/feature-flags/security.test", json={"name":"security.test","enabled":True,"description":"test"})
        self.assertEqual(allowed.status_code, 200, allowed.text)

    def test_idle_expiry_revokes_original_cookie_not_just_local_row(self):
        self.login(); self.verify_mfa()
        stolen = self.client.cookies.get("potapoff_admin_session")
        with contextlib.closing(sqlite3.connect(self.db)) as db:
            db.execute("UPDATE admin_security_sessions SET last_seen_at=?", (int(time.time()) - 301,))
            db.commit()
        self.assertEqual(self.client.get("/api/me").status_code, 401)
        attacker = TestClient(self.client.app)
        try:
            attacker.cookies.set("potapoff_admin_session", stolen)
            self.assertEqual(attacker.get("/api/me").status_code, 401)
        finally:
            attacker.close()
        with contextlib.closing(sqlite3.connect(self.db)) as db:
            self.assertGreaterEqual(db.execute("SELECT COUNT(*) FROM revoked_admin_sessions").fetchone()[0], 1)

    def test_user_agent_binding_revokes_stolen_cookie(self):
        self.login()
        # First protected request registers the binding for TestClient's default UA.
        self.assertEqual(self.client.get("/api/security/session").status_code, 200)
        stolen = self.client.cookies.get("potapoff_admin_session")
        attacker = TestClient(self.client.app, headers={"user-agent":"evil-browser"})
        try:
            attacker.cookies.set("potapoff_admin_session", stolen)
            self.assertEqual(attacker.get("/api/security/session").status_code, 401)
        finally:
            attacker.close()
        self.assertEqual(self.client.get("/api/security/session").status_code, 401)

    def test_security_frontend_guard_is_loaded_before_app(self):
        root = Path(__file__).resolve().parents[1] / "app" / "static"
        html = (root / "index.html").read_text(encoding="utf-8")
        self.assertLess(html.index("/static/security-ui-v7.js"), html.index("/static/app.js"))
        js = (root / "security-ui-v7.js").read_text(encoding="utf-8")
        self.assertIn('body.code === "mfa_required"', js)
        self.assertIn('body.code === "reauth_required"', js)
        self.assertNotIn("localStorage", js)
        self.assertNotIn("sessionStorage", js)


if __name__ == "__main__":
    unittest.main()
