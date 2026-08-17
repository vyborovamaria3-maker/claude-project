import contextlib
import csv
import io
import httpx
import json
import os
import sqlite3
import tempfile
import unittest
import warnings
from pathlib import Path
import sys

ADMIN_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ADMIN_ROOT))
from unittest.mock import patch

from fastapi.testclient import TestClient


class ControlCenterTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.db_path = root / "product.db"
        with contextlib.closing(sqlite3.connect(self.db_path)) as db:
            db.execute("CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, wallet TEXT, password TEXT, metadata TEXT, created_at TEXT)")
            db.execute(
                "INSERT INTO users(username,wallet,password,metadata,created_at) VALUES(?,?,?,?,?)",
                ("=2+2", "WalletABC123", "clear-secret", json.dumps({"api_key": "nested-secret", "safe": "ok"}), "2026-08-04T00:00:00Z"),
            )
            db.execute("CREATE TABLE jobs(id INTEGER PRIMARY KEY, status TEXT, payload TEXT)")
            db.execute("INSERT INTO jobs(status,payload) VALUES(?,?)", ("failed", "token scan"))
            db.commit()
        sources = root / "sources.json"
        sources.write_text(json.dumps([{"id":"test","label":"Test DB","kind":"sqlite","dsn":str(self.db_path),"role":"core"}]))
        logs = root / "logs.json"
        logs.write_text("[]")
        self.old_env = os.environ.copy()
        os.environ.update({
            "ADMIN_SESSION_SECRET":"x"*64,
            "ADMIN_PASSWORD":"correct-password",
            "ADMIN_USERNAME":"admin",
            "ADMIN_SECURE_COOKIE":"false",
            "ADMIN_ENVIRONMENT":"test",
            "ADMIN_AUDIT_DB":str(root/"control.db"),
            "ADMIN_SOURCES_FILE":str(sources),
            "ADMIN_LOGS_FILE":str(logs),
            "SOLANA_RPC_URL":"http://localhost:8899",
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

    def test_protected_routes_require_auth(self):
        for url in ["/api/overview", "/api/sources", "/api/audit", "/api/monitoring"]:
            with self.subTest(url=url):
                self.assertEqual(self.client.get(url).status_code, 401)

    def test_auth_and_modules(self):
        self.login()
        for url in ["/api/overview","/api/search?q=WalletABC123","/api/graph?q=WalletABC123","/api/queues","/api/monitoring","/api/inventory","/api/feature-flags","/api/alerts"]:
            with self.subTest(url=url): self.assertEqual(self.client.get(url).status_code, 200)

    def test_wrong_password_and_rate_limit(self):
        for _ in range(8):
            self.assertEqual(self.client.post("/api/login", json={"username":"admin","password":"wrong"}).status_code, 401)
        self.assertEqual(self.client.post("/api/login", json={"username":"admin","password":"wrong"}).status_code, 429)

    def test_flags_and_alerts(self):
        self.login()
        response = self.client.put("/api/feature-flags/telegram.ai", json={"name":"telegram.ai","enabled":True,"description":"AI analyzer"})
        self.assertEqual(response.status_code, 200); self.assertTrue(response.json()["enabled"])
        response = self.client.post("/api/alerts", json={"level":"warning","title":"RPC slow","message":"Latency > 3s","source":"solana"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.post(f"/api/alerts/{response.json()['id']}/acknowledge").status_code, 200)

    def test_product_sqlite_is_read_only_even_with_relative_path(self):
        from app.config import DataSourceConfig
        from app.database import DataSource
        old_cwd = os.getcwd()
        try:
            os.chdir(self.db_path.parent)
            source = DataSource(DataSourceConfig("relative", "Relative", "sqlite", "product.db"))
            with source.connect() as db:
                with self.assertRaises(sqlite3.OperationalError):
                    db.execute("INSERT INTO jobs(status,payload) VALUES('new','bad')")
        finally:
            os.chdir(old_cwd)

    def test_sensitive_fields_are_masked_recursively(self):
        self.login()
        row = self.client.get("/api/sources/test/tables/users").json()["rows"][0]
        self.assertEqual(row["password"], "••••••")
        self.assertEqual(row["metadata"]["api_key"], "••••••")
        self.assertEqual(row["metadata"]["safe"], "ok")

    def test_csv_formula_injection_is_neutralized(self):
        self.login()
        response = self.client.get("/api/sources/test/tables/users/export.csv")
        parsed = list(csv.DictReader(io.StringIO(response.text)))
        self.assertEqual(parsed[0]["username"], "'=2+2")
        self.assertEqual(parsed[0]["password"], "••••••")

    def test_feature_flag_name_mismatch_rejected(self):
        self.login()
        response = self.client.put("/api/feature-flags/aa", json={"name":"bb","enabled":True,"description":"x"})
        self.assertEqual(response.status_code, 400)

    def test_invalid_solana_values_rejected_before_network(self):
        self.login()
        with patch("httpx.AsyncClient.post") as post:
            response = self.client.post("/api/solana/lookup", json={"mode":"address","value":"not-a-valid-solana-address-00000000"})
            self.assertEqual(response.status_code, 422)
            post.assert_not_called()

    def test_logout_clears_session(self):
        self.login()
        self.assertEqual(self.client.post("/api/logout").status_code, 200)
        self.assertEqual(self.client.get("/api/me").status_code, 401)

    def test_no_resource_warnings(self):
        self.login()
        with warnings.catch_warnings(record=True) as captured:
            warnings.simplefilter("always", ResourceWarning)
            for _ in range(10):
                self.client.get("/api/overview")
                self.client.get("/api/feature-flags")
                self.client.get("/api/audit")
            import gc; gc.collect()
        self.assertFalse([w for w in captured if issubclass(w.category, ResourceWarning)], captured)

    def test_client_ip_uses_client_before_trusted_proxy_hops(self):
        from types import SimpleNamespace
        from app.main import client_ip
        settings = SimpleNamespace(trust_proxy=True, trusted_proxy_hops=2)
        request = SimpleNamespace(
            app=SimpleNamespace(state=SimpleNamespace(settings=settings)),
            client=SimpleNamespace(host="10.0.0.9"),
            headers={"x-forwarded-for": "203.0.113.7, 10.0.0.3, 10.0.0.4"},
        )
        self.assertEqual(client_ip(request), "203.0.113.7")

    def test_client_ip_rejects_short_or_invalid_forwarded_chain(self):
        from types import SimpleNamespace
        from app.main import client_ip
        settings = SimpleNamespace(trust_proxy=True, trusted_proxy_hops=2)
        for forwarded in ("10.0.0.3", "bad-value, 10.0.0.3, 10.0.0.4"):
            request = SimpleNamespace(
                app=SimpleNamespace(state=SimpleNamespace(settings=settings)),
                client=SimpleNamespace(host="10.0.0.9"),
                headers={"x-forwarded-for": forwarded},
            )
            self.assertEqual(client_ip(request), "10.0.0.9")

    def test_sqlite_file_uri_cannot_override_read_only_mode(self):
        from app.config import DataSourceConfig
        from app.database import DataSource
        source = DataSource(DataSourceConfig("uri", "URI", "sqlite", f"file:{self.db_path}?mode=rw"))
        with source.connect() as db:
            with self.assertRaises(sqlite3.OperationalError):
                db.execute("INSERT INTO jobs(status,payload) VALUES('new','write attempt')")

    def test_table_pagination_search_sort_and_limits(self):
        self.login()
        response = self.client.get("/api/sources/test/tables/users", params={"page": 1, "page_size": 9999, "sort": "username", "order": "asc", "search": "WalletABC"})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["page_size"], 250)
        self.assertEqual(body["sort"], "username")
        self.assertEqual(body["order"], "asc")
        self.assertEqual(body["total"], 1)
        self.assertEqual(len(body["rows"]), 1)

    def test_unknown_source_and_table_do_not_leak_internal_errors(self):
        self.login()
        self.assertEqual(self.client.get("/api/sources/missing/tables").status_code, 404)
        response = self.client.get("/api/sources/test/tables/not_a_table")
        self.assertEqual(response.status_code, 404)
        self.assertNotIn(str(self.db_path), response.text)

    def test_session_tampering_expiry_future_issue_and_oversized_lifetime(self):
        from app.auth import issue_session
        settings = self.client.app.state.settings
        valid = issue_session(settings, "admin")
        self.client.cookies.set(settings.session_cookie, valid[:-1] + ("A" if valid[-1] != "A" else "B"))
        self.assertEqual(self.client.get("/api/me").status_code, 401)
        import app.auth as auth
        with patch.object(auth.time, "time", return_value=1_000):
            expired = issue_session(settings, "admin")
        self.client.cookies.set(settings.session_cookie, expired)
        with patch.object(auth.time, "time", return_value=1_000 + settings.session_ttl_seconds + 1):
            self.assertEqual(self.client.get("/api/me").status_code, 401)
        with patch.object(auth.time, "time", return_value=10_000):
            future = issue_session(settings, "admin")
        self.client.cookies.set(settings.session_cookie, future)
        with patch.object(auth.time, "time", return_value=9_000):
            self.assertEqual(self.client.get("/api/me").status_code, 401)

    def test_login_audit_records_success_and_failure_without_password(self):
        self.client.post("/api/login", json={"username":"admin","password":"wrong"})
        self.login()
        audit = self.client.get("/api/audit").json()["rows"]
        login_items = [item for item in audit if item["action"] == "login"]
        self.assertGreaterEqual(len(login_items), 2)
        self.assertTrue(any(item["success"] for item in login_items))
        self.assertTrue(any(not item["success"] for item in login_items))
        self.assertNotIn("correct-password", json.dumps(audit))
        self.assertNotIn('"password"', json.dumps(audit))

    def test_alert_acknowledge_is_idempotent_and_missing_alert_is_404(self):
        self.login()
        created = self.client.post("/api/alerts", json={"level":"error","title":"Worker down","message":"worker stopped","source":"worker"})
        alert_id = created.json()["id"]
        self.assertEqual(self.client.post(f"/api/alerts/{alert_id}/acknowledge").status_code, 200)
        self.assertEqual(self.client.post(f"/api/alerts/{alert_id}/acknowledge").status_code, 404)
        self.assertEqual(self.client.post("/api/alerts/999999/acknowledge").status_code, 404)

    def test_login_limiter_is_thread_safe_under_concurrency(self):
        from app.auth import LoginLimiter
        from concurrent.futures import ThreadPoolExecutor
        limiter = LoginLimiter(max_attempts=8, window_seconds=60)
        def fail_once(_):
            if limiter.allow("same-ip"):
                limiter.record_failure("same-ip")
        with ThreadPoolExecutor(max_workers=20) as pool:
            list(pool.map(fail_once, range(50)))
        self.assertFalse(limiter.allow("same-ip"))
        limiter.clear("same-ip")
        self.assertTrue(limiter.allow("same-ip"))

    def test_production_origin_allowlist_blocks_host_header_spoofing(self):
        from app.auth import hash_password
        from app.main import create_app
        old = os.environ.copy()
        try:
            os.environ.update({
                "ADMIN_ENVIRONMENT":"production",
                "ADMIN_ALLOWED_ORIGINS":"https://admin.example.com",
                "ADMIN_ALLOWED_NETWORKS":"127.0.0.0/8",
                "ADMIN_REQUIRE_NETWORK_ALLOWLIST":"true",
                "ADMIN_REQUIRE_MFA":"true",
                "ADMIN_TOTP_SECRET":"JBSWY3DPEHPK3PXP",
                "ADMIN_REQUIRE_REAUTH":"true",
                "ADMIN_SESSION_BIND_IP":"true",
                "ADMIN_SESSION_BIND_USER_AGENT":"true",
                "ADMIN_SECURE_COOKIE":"true",
                "ADMIN_PASSWORD":"",
                "ADMIN_PASSWORD_HASH":hash_password("correct-password"),
                "ADMIN_TRUST_PROXY":"true",
                "ADMIN_TRUSTED_PROXY_HOPS":"1",
                "SOLANA_RPC_URL":"https://api.mainnet-beta.solana.com",
            })
            forwarded = "127.0.0.1, 127.0.0.1"
            with TestClient(create_app()) as client:
                rejected = client.post(
                    "/api/login",
                    headers={"origin":"https://evil.example", "host":"evil.example", "x-forwarded-for":forwarded},
                    json={"username":"admin","password":"correct-password"},
                )
                self.assertEqual(rejected.status_code, 403)
                accepted = client.post(
                    "/api/login",
                    headers={"origin":"https://admin.example.com", "host":"evil.example", "x-forwarded-for":forwarded},
                    json={"username":"admin","password":"correct-password"},
                )
                self.assertEqual(accepted.status_code, 200)
        finally:
            os.environ.clear(); os.environ.update(old)

    def test_production_requires_explicit_allowed_origins(self):
        from app.config import Settings
        settings = Settings(
            environment="production", admin_password="x", session_secret="x"*64,
            solana_rpc_url="https://api.mainnet-beta.solana.com", allowed_origins=[]
        )
        with self.assertRaisesRegex(RuntimeError, "ADMIN_ALLOWED_ORIGINS"):
            settings.validate()

    def test_security_headers_are_present_on_success_and_auth_errors(self):
        for response in (self.client.get("/api/health"), self.client.get("/api/overview")):
            self.assertEqual(response.headers.get("x-content-type-options"), "nosniff")
            self.assertEqual(response.headers.get("x-frame-options"), "DENY")
            self.assertIn("default-src 'self'", response.headers.get("content-security-policy", ""))
            self.assertEqual(response.headers.get("cache-control"), "no-store")

    def test_source_failure_returns_sanitized_503(self):
        self.login()
        with patch.object(self.client.app.state.registry.get("test"), "rows", side_effect=RuntimeError(f"secret path {self.db_path}")):
            response = self.client.get("/api/sources/test/tables/users")
        self.assertEqual(response.status_code, 503)
        self.assertNotIn(str(self.db_path), response.text)

    def test_solana_rpc_success_and_upstream_failure_are_handled(self):
        self.login()
        valid_address = "11111111111111111111111111111111"
        class FakeResponse:
            def __init__(self, payload, status=200): self.payload, self.status_code = payload, status
            def raise_for_status(self):
                if self.status_code >= 400: raise RuntimeError("upstream secret")
            def json(self): return self.payload
        async def ok_post(*args, **kwargs): return FakeResponse({"jsonrpc":"2.0","id":1,"result":{"value":123}})
        with patch("httpx.AsyncClient.post", side_effect=ok_post):
            response = self.client.post("/api/solana/lookup", json={"mode":"address","value":valid_address})
            self.assertEqual(response.status_code, 200)
            self.assertIn("result", response.json()["rpc"])
        async def bad_post(*args, **kwargs): raise httpx.ConnectError("rpc-key=secret")
        with patch("httpx.AsyncClient.post", side_effect=bad_post):
            response = self.client.post("/api/solana/lookup", json={"mode":"address","value":valid_address})
            self.assertEqual(response.status_code, 502)
            self.assertNotIn("secret", response.text)


if __name__ == "__main__":
    unittest.main()
