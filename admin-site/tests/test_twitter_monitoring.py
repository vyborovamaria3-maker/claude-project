from __future__ import annotations

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

ADMIN_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ADMIN_ROOT))

from app.auth import require_admin
from app.services import X_TABLES
from app.twitter_monitoring import TWITTER_MONITOR_TABLES, TWITTER_SETTINGS_FIELDS, TwitterMonitoringStore, find_twitter_source
from app.twitter_monitoring_api import TwitterCrawlerSettingsBody, _update_via_backend, build_twitter_monitoring_router


class _Audit:
    def __init__(self) -> None:
        self.rows: list[dict] = []

    def record(self, **kwargs) -> None:
        self.rows.append(kwargs)


class _FailingAudit:
    def record(self, **_kwargs) -> None:
        raise RuntimeError("audit unavailable")


class _Store:
    def snapshot(self) -> dict:
        return {
            "source_id": "potapoff",
            "source_label": "POTAPoff backend",
            "settings": {"id": 1, "updated_at": "2026-09-13T12:00:00+00:00"},
            "metrics": {"accounts_total": 12, "stale_running_runs": 0},
            "candidate_statuses": [{"status": "queued", "count": 3}],
            "recent_runs": [],
            "recent_accounts": [],
            "tables": list(TWITTER_MONITOR_TABLES),
        }


def _payload() -> dict:
    return {
        "expected_updated_at": "2026-09-13T12:00:00+00:00",
        "enabled": True,
        "query_limit": 50,
        "process_limit": 250,
        "batch_size": 25,
        "max_depth": 2,
        "min_relevance": 35.0,
        "network_mode": "following",
        "network_limit": 100,
        "lease_seconds": 300,
        "rescore_limit": 1500,
        "public_enabled": True,
        "public_dexscreener_latest": True,
        "public_dexscreener_boosts": True,
        "public_db_solana_tokens": 500,
        "public_cmc_limit": 0,
        "public_rescore_limit": 3000,
    }


def _backend_row() -> dict:
    payload = _payload()
    payload.pop("expected_updated_at")
    return {"id": 1, **payload, "updated_at": "2026-09-13T12:01:00+00:00"}


class TwitterMonitoringTest(unittest.TestCase):
    def _client(self, store: _Store, *, audit=None, backend_side_effect=None):
        app = FastAPI()
        app.state.registry = object()
        app.state.settings = SimpleNamespace(trust_proxy=False, trusted_proxy_hops=1)
        app.state.audit = audit or _Audit()
        app.include_router(build_twitter_monitoring_router())
        app.dependency_overrides[require_admin] = lambda: {"sub": "admin"}

        store_patcher = patch("app.twitter_monitoring_api._store", return_value=store)
        store_patcher.start()
        self.addCleanup(store_patcher.stop)

        backend_patcher = patch("app.twitter_monitoring_api._update_via_backend", return_value=_backend_row())
        backend_mock = backend_patcher.start()
        if backend_side_effect is not None:
            backend_mock.side_effect = backend_side_effect
        self.addCleanup(backend_patcher.stop)

        client = TestClient(app)
        self.addCleanup(client.close)
        return client, app, backend_mock

    def test_snapshot_route_returns_monitoring_data(self):
        client, _app, _backend = self._client(_Store())
        response = client.get("/api/twitter-monitoring")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["source_id"], "potapoff")
        self.assertEqual(body["metrics"]["accounts_total"], 12)
        self.assertEqual(body["metrics"]["stale_running_runs"], 0)
        self.assertIn("twitter_crawler_runs", body["tables"])
        self.assertIn("twitter_accounts", body["tables"])

    def test_settings_update_passes_validated_payload_to_backend_only(self):
        client, app, backend = self._client(_Store())
        response = client.put("/api/twitter-monitoring/settings", json=_payload())
        self.assertEqual(response.status_code, 200)
        sent = backend.call_args.args[0].model_dump()
        self.assertEqual(set(sent) - {"expected_updated_at"}, set(TWITTER_SETTINGS_FIELDS))
        self.assertEqual(sent["expected_updated_at"], datetime(2026, 9, 13, 12, 0, tzinfo=timezone.utc))
        self.assertTrue(app.state.audit.rows[-1]["success"])
        self.assertEqual(app.state.audit.rows[-1]["action"], "twitter_crawler_settings_update")

    def test_settings_audit_uses_effective_forwarded_client_ip(self):
        client, app, _backend = self._client(_Store())
        app.state.settings.trust_proxy = True
        app.state.settings.trusted_proxy_hops = 1
        response = client.put(
            "/api/twitter-monitoring/settings",
            json=_payload(),
            headers={"x-forwarded-for": "203.0.113.10, 10.0.0.2"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(app.state.audit.rows[-1]["ip_address"], "203.0.113.10")

    def test_settings_update_result_survives_audit_storage_failure(self):
        client, _app, _backend = self._client(_Store(), audit=_FailingAudit())
        response = client.put("/api/twitter-monitoring/settings", json=_payload())
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["ok"])

    def test_settings_update_detects_backend_optimistic_lock_conflict(self):
        conflict = HTTPException(status_code=409, detail="Twitter settings changed in another session; refresh and retry")
        client, app, _backend = self._client(_Store(), backend_side_effect=conflict)
        response = client.put("/api/twitter-monitoring/settings", json=_payload())
        self.assertEqual(response.status_code, 409)
        self.assertIn("another session", response.json()["detail"])
        self.assertFalse(app.state.audit.rows[-1]["success"])
        self.assertEqual(app.state.audit.rows[-1]["details"]["reason"], "optimistic_lock_conflict")

    def test_settings_request_rejects_invalid_ranges_modes_and_extra_fields(self):
        client, _app, backend = self._client(_Store())
        for field, value in (("query_limit", 9), ("network_mode", "random"), ("public_cmc_limit", 5001)):
            invalid = _payload()
            invalid[field] = value
            self.assertEqual(client.put("/api/twitter-monitoring/settings", json=invalid).status_code, 422)

        invalid = _payload()
        invalid["unexpected_setting"] = 1
        self.assertEqual(client.put("/api/twitter-monitoring/settings", json=invalid).status_code, 422)
        backend.assert_not_called()

    def test_settings_model_rejects_non_finite_relevance_and_naive_lock_timestamp(self):
        invalid = _payload()
        invalid["min_relevance"] = float("nan")
        with self.assertRaises(ValidationError):
            TwitterCrawlerSettingsBody.model_validate(invalid)

        invalid = _payload()
        invalid["expected_updated_at"] = "2026-09-13T12:00:00"
        with self.assertRaises(ValidationError):
            TwitterCrawlerSettingsBody.model_validate(invalid)

    def test_product_monitoring_store_has_no_write_method(self):
        self.assertFalse(hasattr(TwitterMonitoringStore, "update_settings"))

    def test_backend_writer_uses_dedicated_header_and_internal_url(self):
        body = TwitterCrawlerSettingsBody.model_validate(_payload())
        response = MagicMock()
        response.status_code = 200
        response.json.return_value = {"ok": True, "settings": _backend_row()}
        http_client = MagicMock()
        http_client.__enter__.return_value = http_client
        http_client.__exit__.return_value = False
        http_client.put.return_value = response
        test_key = "unit-test-placeholder-key-value-0001"

        with patch.dict(
            "os.environ",
            {
                "TWITTER_CRAWLER_ADMIN_KEY": test_key,
                "ADMIN_TWITTER_BACKEND_URL": "http://backend:8000",
            },
            clear=False,
        ):
            with patch("app.twitter_monitoring_api.httpx.Client", return_value=http_client):
                result = _update_via_backend(body)

        self.assertEqual(result["id"], 1)
        self.assertEqual(http_client.put.call_args.kwargs["headers"]["X-Twitter-Crawler-Admin-Key"], test_key)
        self.assertEqual(http_client.put.call_args.args[0], "http://backend:8000/api/v1/twitter/admin/crawler-settings")

    def test_find_twitter_source_prefers_named_potapoff_postgres(self):
        preferred = SimpleNamespace(config=SimpleNamespace(kind="postgres", role="core"))
        fallback = SimpleNamespace(config=SimpleNamespace(kind="postgres", role="core"))

        class Registry:
            def get(self, source_id):
                self.requested = source_id
                return preferred

            def all(self):
                return [fallback]

        registry = Registry()
        self.assertIs(find_twitter_source(registry), preferred)
        self.assertEqual(registry.requested, "potapoff")

    def test_x_domain_contains_new_registry_tables(self):
        for table in TWITTER_MONITOR_TABLES:
            with self.subTest(table=table):
                self.assertIn(table, X_TABLES)

    def test_static_control_center_wires_twitter_monitoring_tab(self):
        index = (ADMIN_ROOT / "app" / "static" / "index.html").read_text(encoding="utf-8")
        script = (ADMIN_ROOT / "app" / "static" / "twitter-monitoring-v1.js").read_text(encoding="utf-8")
        self.assertIn('id="twitterMonitoringNav"', index)
        self.assertIn('/static/twitter-monitoring-v1.css', index)
        self.assertIn('/static/twitter-monitoring-v1.js', index)
        self.assertIn('/api/twitter-monitoring/settings', script)
        self.assertIn('expected_updated_at: settings.updated_at', script)
        self.assertIn('navItem.id !== "twitterMonitoringNav"', script)
        self.assertIn('stale_running_runs', script)
        self.assertIn('Read-only таблицы backend registry', script)


if __name__ == "__main__":
    unittest.main()
