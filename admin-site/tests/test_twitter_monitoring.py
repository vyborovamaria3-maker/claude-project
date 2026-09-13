from __future__ import annotations

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

ADMIN_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ADMIN_ROOT))

from app.auth import require_admin
from app.services import X_TABLES
from app.twitter_monitoring import (
    TWITTER_MONITOR_TABLES,
    TWITTER_SETTINGS_FIELDS,
    TwitterMonitoringStore,
    find_twitter_source,
)
from app.twitter_monitoring_api import TwitterCrawlerSettingsBody, build_twitter_monitoring_router


class _Audit:
    def __init__(self) -> None:
        self.rows: list[dict] = []

    def record(self, **kwargs) -> None:
        self.rows.append(kwargs)


class _FailingAudit:
    def record(self, **_kwargs) -> None:
        raise RuntimeError("audit unavailable")


class _Store:
    def __init__(self) -> None:
        self.conflict = False
        self.last_values = None
        self.last_expected = None

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

    def update_settings(self, values, *, expected_updated_at):
        self.last_values = dict(values)
        self.last_expected = expected_updated_at
        if self.conflict:
            return None
        return {"id": 1, **values, "updated_at": datetime(2026, 9, 13, 12, 1, tzinfo=timezone.utc)}


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


class TwitterMonitoringTest(unittest.TestCase):
    def _client(self, store: _Store, *, audit=None):
        app = FastAPI()
        app.state.registry = object()
        app.state.audit = audit or _Audit()
        app.include_router(build_twitter_monitoring_router())
        app.dependency_overrides[require_admin] = lambda: {"sub": "admin"}
        patcher = patch("app.twitter_monitoring_api._store", return_value=store)
        patcher.start()
        self.addCleanup(patcher.stop)
        client = TestClient(app)
        self.addCleanup(client.close)
        return client, app

    def test_snapshot_route_returns_monitoring_data(self):
        client, _app = self._client(_Store())
        response = client.get("/api/twitter-monitoring")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["source_id"], "potapoff")
        self.assertEqual(body["metrics"]["accounts_total"], 12)
        self.assertEqual(body["metrics"]["stale_running_runs"], 0)
        self.assertIn("twitter_crawler_runs", body["tables"])
        self.assertIn("twitter_accounts", body["tables"])

    def test_settings_update_passes_only_whitelisted_validated_fields(self):
        store = _Store()
        client, app = self._client(store)
        response = client.put("/api/twitter-monitoring/settings", json=_payload())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(store.last_values), set(TWITTER_SETTINGS_FIELDS))
        self.assertEqual(store.last_expected, datetime(2026, 9, 13, 12, 0, tzinfo=timezone.utc))
        self.assertTrue(app.state.audit.rows[-1]["success"])
        self.assertEqual(app.state.audit.rows[-1]["action"], "twitter_crawler_settings_update")

    def test_settings_update_result_survives_audit_storage_failure(self):
        store = _Store()
        client, _app = self._client(store, audit=_FailingAudit())
        response = client.put("/api/twitter-monitoring/settings", json=_payload())
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["ok"])

        store.conflict = True
        response = client.put("/api/twitter-monitoring/settings", json=_payload())
        self.assertEqual(response.status_code, 409)

    def test_settings_update_detects_optimistic_lock_conflict(self):
        store = _Store()
        store.conflict = True
        client, app = self._client(store)
        response = client.put("/api/twitter-monitoring/settings", json=_payload())
        self.assertEqual(response.status_code, 409)
        self.assertIn("another session", response.json()["detail"])
        self.assertFalse(app.state.audit.rows[-1]["success"])
        self.assertEqual(
            app.state.audit.rows[-1]["details"]["reason"],
            "optimistic_lock_conflict",
        )

    def test_settings_request_rejects_invalid_ranges_modes_and_extra_fields(self):
        response_store = _Store()
        client, _app = self._client(response_store)

        invalid = _payload()
        invalid["query_limit"] = 9
        self.assertEqual(
            client.put("/api/twitter-monitoring/settings", json=invalid).status_code,
            422,
        )
        self.assertIsNone(response_store.last_values)

        invalid = _payload()
        invalid["network_mode"] = "random"
        self.assertEqual(
            client.put("/api/twitter-monitoring/settings", json=invalid).status_code,
            422,
        )

        invalid = _payload()
        invalid["public_cmc_limit"] = 5001
        self.assertEqual(
            client.put("/api/twitter-monitoring/settings", json=invalid).status_code,
            422,
        )

        invalid = _payload()
        invalid["unexpected_setting"] = 1
        self.assertEqual(
            client.put("/api/twitter-monitoring/settings", json=invalid).status_code,
            422,
        )

    def test_settings_model_rejects_non_finite_relevance_and_naive_lock_timestamp(self):
        invalid = _payload()
        invalid["min_relevance"] = float("nan")
        with self.assertRaises(ValidationError):
            TwitterCrawlerSettingsBody.model_validate(invalid)

        invalid = _payload()
        invalid["expected_updated_at"] = "2026-09-13T12:00:00"
        with self.assertRaises(ValidationError):
            TwitterCrawlerSettingsBody.model_validate(invalid)

    def test_store_rejects_partial_or_unknown_setting_sets_before_connecting(self):
        source = SimpleNamespace(
            config=SimpleNamespace(kind="postgres", dsn="postgresql://unused")
        )
        store = TwitterMonitoringStore(source)
        with self.assertRaisesRegex(ValueError, "Missing Twitter setting"):
            store.update_settings(
                {"enabled": True},
                expected_updated_at=datetime.now(timezone.utc),
            )
        values = {field: 1 for field in TWITTER_SETTINGS_FIELDS}
        values["unknown"] = 1
        with self.assertRaisesRegex(ValueError, "Unsupported Twitter setting"):
            store.update_settings(
                values,
                expected_updated_at=datetime.now(timezone.utc),
            )

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
        script = (ADMIN_ROOT / "app" / "static" / "twitter-monitoring-v1.js").read_text(
            encoding="utf-8"
        )
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
