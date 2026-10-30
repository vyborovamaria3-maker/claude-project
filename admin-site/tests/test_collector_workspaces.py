import os
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.auth import require_admin
from app.collector_workspaces import build_collector_workspaces_router, local_origin

RealAsyncClient = httpx.AsyncClient


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.app = FastAPI()
        self.app.include_router(build_collector_workspaces_router())
        self.events = []
        self.app.state.audit = SimpleNamespace(record=lambda **event: self.events.append(event))
        self.app.dependency_overrides[require_admin] = lambda: {"sub": "operator"}
        self.client = TestClient(self.app)
        self.environment = patch.dict(os.environ, {
            "ADMIN_COLLECTOR_API_ORIGIN": "http://127.0.0.1:3100",
            "ADMIN_COLLECTOR_BACKEND_ORIGIN": "http://127.0.0.1:8000",
            "ADMIN_TGINVITE_ACCESS_TOKEN": "server-only-operator-token",
            "TG_COLLECTOR_ADMIN_TOKEN": "server-only-collector-key-123456789",
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)

    @contextmanager
    def upstream(self, handler):
        transport = httpx.MockTransport(handler)
        def client(**kwargs):
            return RealAsyncClient(transport=transport, **kwargs)
        with patch("app.collector_workspaces.httpx.AsyncClient", side_effect=client):
            yield

    def test_every_workspace_and_api_requires_admin_session(self):
        def reject():
            raise HTTPException(401, "Login required")
        self.app.dependency_overrides[require_admin] = reject
        for path in ("/collectors/diagnostics", "/collectors/apify", "/collectors/blockchain", "/api/blockchain/settings", "/api/rpc-health", "/api/trending", "/api/market-overview", "/api/integrations/apify", "/api/collector-connections", "/collectors/x-collector", "/collectors/tg-collector", "/collectors/tg-invite", "/api/integrations/x-collector", "/api/integrations/tg-collector", "/api/tginvite/identity", "/api/v1/telegram/teragram/status"):
            self.assertEqual(self.client.get(path).status_code, 401, path)

    def test_only_known_pages_are_served_and_missing_build_fails_honestly(self):
        with tempfile.TemporaryDirectory() as directory, patch("app.collector_workspaces.ROOT", Path(directory)):
            self.assertEqual(self.client.get("/collectors/tg-invite").status_code, 503)
            Path(directory, "index.html").write_text("native admin workspace")
            for module in ("x-collector", "tg-collector", "tg-invite", "diagnostics", "apify", "blockchain"):
                response = self.client.get("/collectors/" + module)
                self.assertEqual(response.status_code, 200)
                self.assertIn("no-store", response.headers["cache-control"])
            self.assertEqual(self.client.get("/collectors/arbitrary").status_code, 404)

    def test_invite_uses_server_owner_credentials_and_never_browser_cookies(self):
        def handler(request):
            self.assertEqual(str(request.url), "http://127.0.0.1:3100/api/tginvite/identity")
            self.assertEqual(request.headers["authorization"], "Bearer server-only-operator-token")
            self.assertNotIn("cookie", request.headers)
            self.assertNotIn("x-owner-id", request.headers)
            return httpx.Response(200, json={"ownerId": "existing-owner"}, headers={"Set-Cookie": "secret=upstream"})
        with self.upstream(handler):
            response = self.client.get("/api/tginvite/identity", headers={"Authorization": "Bearer attacker", "Cookie": "product=attacker", "X-Owner-Id": "attacker"})
        self.assertEqual(response.json(), {"ownerId": "existing-owner"})
        self.assertNotIn("set-cookie", response.headers)
        self.assertNotIn("server-only", response.text)

    def test_same_origin_required_and_mutations_are_never_retried(self):
        calls = []
        def handler(request):
            calls.append(request)
            self.assertEqual(request.headers["origin"], "http://127.0.0.1:3100")
            return httpx.Response(202, json={"status": "queued"})
        with self.upstream(handler):
            for headers in ({}, {"Origin": "https://evil.invalid"}, {"Origin": "http://testserver", "Sec-Fetch-Site": "cross-site"}):
                self.assertEqual(self.client.post("/api/integrations/x-collector", json={"action": "publish-start"}, headers=headers).status_code, 403)
            self.assertEqual(len(calls), 0)
            response = self.client.post("/api/integrations/x-collector", json={"action": "publish-start"}, headers={"Origin": "http://testserver"})
        self.assertEqual(response.status_code, 202)
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.events[0]["details"], {"method": "POST", "status": 202})
        self.assertNotIn("publish-start", str(self.events))

    def test_tg_auto_connect_uses_admin_session_and_full_api_routes(self):
        with self.upstream(lambda request: httpx.Response(200, json={"configured": True, "stats": {}, "workerOnline": True})):
            self.assertEqual(self.client.post("/api/integrations/tg-collector/session", headers={"Origin": "http://testserver"}).json(), {"connected": True, "workerOnline": True})
        for suffix in ("", "/graph", "/discovery"):
            def handler(request):
                self.assertEqual(request.headers["authorization"], "Bearer server-only-collector-key-123456789")
                return httpx.Response(200, json={"ok": True})
            with self.upstream(handler):
                self.assertEqual(self.client.get("/api/integrations/tg-collector" + suffix).status_code, 200)

    def test_x_uses_configured_server_identity(self):
        def handler(request):
            self.assertEqual(request.headers["authorization"], "Bearer server-only-x-operator")
            self.assertNotIn("cookie", request.headers)
            return httpx.Response(200, json={"installed": True})
        with patch.dict(os.environ, {"ADMIN_COLLECTOR_ACCESS_TOKEN": "server-only-x-operator"}), self.upstream(handler):
            self.assertEqual(self.client.get("/api/integrations/x-collector", headers={"Authorization": "Bearer attacker"}).status_code, 200)

    def test_connections_probe_is_read_only_and_does_not_expose_identity_or_secrets(self):
        calls = []
        def handler(request):
            calls.append(request)
            self.assertEqual(request.method, "GET")
            if request.url.path.endswith("identity"):
                return httpx.Response(200, json={"ownerId": "123e4567-e89b-12d3-a456-426614174000"})
            return httpx.Response(200, json={"installed": True, "db": {"reachable": True}, "configured": True, "stats": {}, "workerOnline": False})
        with self.upstream(handler):
            result = self.client.get("/api/collector-connections")
        self.assertEqual(result.status_code, 200)
        self.assertTrue(result.json()["ready"])
        self.assertFalse(result.json()["services"]["tgCollector"]["workerOnline"])
        self.assertEqual(len(calls), 4)
        self.assertNotIn("ownerId", result.text)
        self.assertNotIn("server-only", result.text)

    def test_tg_connect_never_claims_success_without_real_snapshot(self):
        for status in (401, 403, 404, 503):
            with self.upstream(lambda request: httpx.Response(status, json={"error": "unavailable"})):
                response = self.client.post("/api/integrations/tg-collector/session", headers={"Origin": "http://testserver"})
                self.assertEqual(response.status_code, status)
                self.assertFalse(response.json()["connected"])
        for payload in ({}, {"configured": False, "stats": {}}, []):
            with self.upstream(lambda request: httpx.Response(200, json=payload)):
                self.assertEqual(self.client.post("/api/integrations/tg-collector/session", headers={"Origin": "http://testserver"}).status_code, 502)

    def test_completed_mutation_does_not_become_retryable_if_audit_fails(self):
        def fail(**kwargs):
            raise RuntimeError("audit offline")
        self.app.state.audit = SimpleNamespace(record=fail)
        with self.upstream(lambda request: httpx.Response(202, json={"status": "queued"})):
            response = self.client.post("/api/integrations/x-collector", json={"action": "publish-start"}, headers={"Origin": "http://testserver"})
        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.json(), {"status": "queued"})

    def test_missing_identity_and_unavailable_upstream_fail_closed(self):
        with patch.dict(os.environ, {"ADMIN_TGINVITE_ACCESS_TOKEN": ""}):
            self.assertEqual(self.client.get("/api/tginvite/identity").status_code, 503)
        def unavailable(request):
            raise httpx.ConnectError("private diagnostic canary")
        with self.upstream(unavailable):
            response = self.client.get("/api/integrations/x-collector")
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("canary", response.text)

    def test_unknown_paths_redirects_and_oversized_requests_are_rejected(self):
        self.assertEqual(self.client.get("/api/tginvite/arbitrary").status_code, 404)
        with self.upstream(lambda request: httpx.Response(302, headers={"Location": "https://evil.invalid"})):
            self.assertEqual(self.client.get("/api/tginvite/identity").status_code, 502)
        self.assertEqual(self.client.post("/api/tginvite/mtproto", content=b"x" * 300001, headers={"Origin": "http://testserver"}).status_code, 413)

    def test_upstream_address_cannot_be_a_remote_destination(self):
        for value in ("https://evil.invalid", "http://127.0.0.1:3100/path", "http://u:p@localhost:3100", "http://localhost:3100?dest=evil", "http://localhost:bad", "http://localhost:0"):
            with patch.dict(os.environ, {"ADMIN_COLLECTOR_API_ORIGIN": value}):
                with self.assertRaises(HTTPException):
                    local_origin("ADMIN_COLLECTOR_API_ORIGIN", "http://127.0.0.1:3100")

    def test_settings_bridges_preserve_upload_and_operator_identity(self):
        def handler(request):
            self.assertEqual(request.headers["authorization"], "Bearer server-only-operator-token")
            self.assertEqual(request.headers["content-type"], "application/octet-stream")
            self.assertEqual(request.content, b"xlsx-placeholder")
            self.assertEqual(request.url.params["action"], "import")
            return httpx.Response(200, json={"ok": True})
        with self.upstream(handler):
            response = self.client.post("/api/blockchain/settings?action=import&category=migrated&name=data.xlsx", content=b"xlsx-placeholder", headers={"Origin": "http://testserver", "Content-Type": "application/octet-stream"})
        self.assertEqual(response.status_code, 200)

    def test_diagnostics_are_read_only_and_apify_paths_are_bounded(self):
        with self.upstream(lambda request: httpx.Response(200, json={"ok": True})):
            for path in ("/api/rpc-health", "/api/trending", "/api/market-overview", "/api/integrations/apify/runs/abc-123"):
                self.assertEqual(self.client.get(path).status_code, 200)
            self.assertEqual(self.client.post("/api/rpc-health", headers={"Origin": "http://testserver"}).status_code, 405)
            self.assertEqual(self.client.get("/api/integrations/apify/runs/abc/other").status_code, 404)


if __name__ == "__main__":
    unittest.main()
