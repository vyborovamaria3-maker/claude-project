from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
import sys

from fastapi.testclient import TestClient

ADMIN_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ADMIN_ROOT.parent
sys.path.insert(0, str(ADMIN_ROOT))

from app.analysis_catalog import CATALOG, CATALOG_BY_ID, DOMAINS, VALUE_TYPES
from app.analysis_profiles import AnalysisProfileStore, evaluate_threshold, resolve_path, validate_threshold


class AnalysisProfileUnitTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = AnalysisProfileStore(str(Path(self.tmp.name) / "control.db"))

    def tearDown(self):
        self.tmp.cleanup()

    def test_catalog_is_unique_and_structurally_valid(self):
        self.assertEqual(len(CATALOG), len(CATALOG_BY_ID))
        self.assertEqual({row["domain"] for row in CATALOG}, DOMAINS)
        for row in CATALOG:
            with self.subTest(domain=row["domain"], key=row["key"]):
                self.assertIn(row["type"], VALUE_TYPES)
                self.assertIn(row["runtime_state"], {"active", "available", "legacy"})
                self.assertTrue(row["source"])
                self.assertTrue(row["project_ref"])
                validate_threshold(row["threshold"], value_type=row["type"], scale=row["scale"])
                if row["runtime_state"] == "legacy":
                    self.assertFalse(row["default_enabled"])

    def test_catalog_covers_critical_project_metrics(self):
        required = {
            "wallet": {"migration_rate", "rate_300k", "risk_score", "rug_rate", "success_rate", "avg_mc_usd", "profit_total", "similarity_score"},
            "token": {"market_cap_usd", "ath_usd", "liquidity_usd", "volume_24h", "tx_count_24h", "holder_count", "twitter_bot_score"},
            "telegram": {"calls_count", "evaluated_calls", "successful_calls", "rug_calls", "early_calls", "win_rate", "rug_rate", "avg_roi", "channel_score"},
            "x": {"total_tweets", "total_views", "total_likes", "total_retweets", "unique_mentioners", "bot_risk_score", "anomaly_count", "engagement_rate", "bot_ratio"},
        }
        for domain, keys in required.items():
            self.assertTrue(keys.issubset({row["key"] for row in CATALOG if row["domain"] == domain}))

    def test_ratio_percent_threshold_boundaries(self):
        self.assertTrue(evaluate_threshold(0.20, ">= 20%", value_type="percent", scale="ratio"))
        self.assertFalse(evaluate_threshold(0.1999, ">= 20%", value_type="percent", scale="ratio"))
        self.assertTrue(evaluate_threshold(20.0, ">= 20%", value_type="percent", scale="percent100"))

    def test_currency_suffix_and_duration_are_not_ambiguous(self):
        self.assertTrue(evaluate_threshold(100_000, ">= $100k", value_type="currency", scale="raw"))
        self.assertTrue(evaluate_threshold(1_800, ">= 30m", value_type="duration", scale="seconds"))
        self.assertFalse(evaluate_threshold(1_799, ">= 30m", value_type="duration", scale="seconds"))
        self.assertTrue(evaluate_threshold(0.5, ">= 30m", value_type="duration", scale="hours"))

    def test_boolean_and_invalid_thresholds(self):
        self.assertTrue(evaluate_threshold(True, "true", value_type="boolean"))
        self.assertFalse(evaluate_threshold(False, "true", value_type="boolean"))
        for expression, value_type, scale in [
            (">= 20", "percent", "ratio"),
            ("> true", "boolean", "raw"),
            (">= bananas", "number", "raw"),
            ("> 2026-01-01", "timestamp", "raw"),
        ]:
            with self.subTest(expression=expression):
                with self.assertRaises(ValueError):
                    validate_threshold(expression, value_type=value_type, scale=scale)

    def test_resolve_nested_and_list_paths(self):
        payload = {"aggregated": {"botRatio": 0.1}, "shillers": [{"tweets": 2}, {"tweets": 4}]}
        self.assertEqual(resolve_path(payload, "aggregated.botRatio"), 0.1)
        self.assertEqual(resolve_path(payload, "shillers.tweets"), [2, 4])
        self.assertIsNone(resolve_path(payload, "missing.value"))

    def test_builtin_toggle_persists_and_legacy_cannot_enable(self):
        updated = self.store.update_builtin("wallet", "risk_score", enabled=False, threshold="<= 60", username="admin")
        self.assertFalse(updated["enabled"])
        self.assertEqual(updated["threshold"], "<= 60")
        reread = next(row for row in self.store.list("wallet") if row["key"] == "risk_score")
        self.assertFalse(reread["enabled"])
        legacy = next(row for row in CATALOG if row["runtime_state"] == "legacy")
        with self.assertRaises(ValueError):
            self.store.update_builtin(legacy["domain"], legacy["key"], enabled=True, threshold=legacy["threshold"], username="admin")

    def test_custom_create_update_delete_and_validation(self):
        row = self.store.create_custom(
            "x", key="custom_quality", label="Custom quality", source="aggregated.engagementRate",
            value_type="percent", scale="ratio", threshold=">= 2%", enabled=True,
            description="test metric", username="admin"
        )
        self.assertTrue(row["custom"])
        self.assertTrue(row["enabled"])
        row = self.store.update_custom("x", "custom_quality", enabled=False, threshold=">= 3%", username="admin")
        self.assertFalse(row["enabled"])
        self.assertEqual(row["threshold"], ">= 3%")
        self.assertTrue(self.store.delete_custom("x", "custom_quality", "admin"))
        self.assertFalse(any(item["key"] == "custom_quality" for item in self.store.list("x")))
        for source in ("items[0].value", "a..b", "a-b", ".hidden"):
            with self.subTest(source=source):
                with self.assertRaises(ValueError):
                    self.store.create_custom(
                        "x", key="bad_source", label="Bad", source=source,
                        value_type="number", scale="raw", threshold=">= 1", enabled=True,
                        description="", username="admin"
                    )

    def test_backtest_is_strict_about_missing_fields(self):
        # Use only two controlled thresholds to make expected coverage deterministic.
        for row in self.store.list("wallet"):
            if row["key"] not in {"migration_rate", "risk_score"} and row["enabled"]:
                self.store.update_builtin("wallet", row["key"], enabled=False, threshold=row["threshold"], username="test")
        self.store.update_builtin("wallet", "migration_rate", enabled=True, threshold=">= 20%", username="test")
        self.store.update_builtin("wallet", "risk_score", enabled=True, threshold="<= 55", username="test")
        result = self.store.backtest("wallet", [
            {"migrationRate": 0.30, "riskScore": 20},
            {"migrationRate": 0.30},
            {"migrationRate": 0.10, "riskScore": 20},
        ])
        self.assertEqual(result["records"], 3)
        self.assertEqual(result["complete_records"], 2)
        self.assertEqual(result["passed_all"], 1)
        self.assertEqual(result["pass_rate"], 0.5)
        self.assertAlmostEqual(result["coverage"], 2 / 3, places=6)
        self.assertTrue(result["sample"][0]["passed"])
        self.assertFalse(result["sample"][1]["complete"])
        self.assertFalse(result["sample"][1]["passed"])

    def test_list_aggregation_in_backtest(self):
        self.store.create_custom(
            "x", key="avg_shiller_tweets", label="Avg shiller tweets", source="shillers.tweets",
            value_type="number", scale="raw", threshold=">= 3", enabled=True,
            description="average list values", username="admin"
        )
        for row in self.store.list("x"):
            if row["key"] != "avg_shiller_tweets" and row["enabled"]:
                self.store.update_builtin("x", row["key"], enabled=False, threshold=row["threshold"], username="test")
        result = self.store.backtest("x", [{"shillers": [{"tweets": 2}, {"tweets": 4}]}])
        self.assertEqual(result["pass_rate"], 1.0)
        self.assertEqual(result["coverage"], 1.0)

    def test_catalog_sources_are_grounded_in_project_code(self):
        checks = {
            REPO_ROOT / "solana-launcher/lib/trade/dev.ts": ["riskScore", "rugRate", "successRate", "rate300k", "avgTimeBetweenLaunchesSec"],
            REPO_ROOT / "solana-launcher/backend/app/models/analytics.py": ["liquidity_usd", "volume_24h", "tx_count_24h", "holder_count", "similarity_score"],
            REPO_ROOT / "solana-launcher/backend/app/services/social_intelligence.py": ["score_channel_metrics", "early_rate", "roi_component", "rug_rate"],
            REPO_ROOT / "solana-launcher/app/api/trade/dev-twitter/route.ts": ["botRiskScore", "anomalyCount", "engagementRate", "verifiedAuthors", "botRatio"],
        }
        for path, fields in checks.items():
            self.assertTrue(path.exists(), path)
            text = path.read_text(encoding="utf-8")
            for field in fields:
                self.assertIn(field, text, f"{field} missing from {path}")


class AnalysisProfileApiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        (root / "sources.json").write_text("[]", encoding="utf-8")
        (root / "logs.json").write_text("[]", encoding="utf-8")
        self.old_env = os.environ.copy()
        os.environ.update({
            "ADMIN_SESSION_SECRET": "x" * 64,
            "ADMIN_PASSWORD": "correct-password",
            "ADMIN_USERNAME": "admin",
            "ADMIN_SECURE_COOKIE": "false",
            "ADMIN_ENVIRONMENT": "test",
            "ADMIN_AUDIT_DB": str(root / "control.db"),
            "ADMIN_SOURCES_FILE": str(root / "sources.json"),
            "ADMIN_LOGS_FILE": str(root / "logs.json"),
            "SOLANA_RPC_URL": "http://localhost:8899",
        })
        from app.main_admin import create_app
        self.client = TestClient(create_app())

    def tearDown(self):
        self.client.close()
        os.environ.clear(); os.environ.update(self.old_env)
        self.tmp.cleanup()

    def login(self):
        response = self.client.post("/api/login", json={"username": "admin", "password": "correct-password"})
        self.assertEqual(response.status_code, 200)

    def test_routes_require_auth(self):
        self.assertEqual(self.client.get("/api/analysis-profiles").status_code, 401)
        self.assertEqual(self.client.post("/api/analysis-profiles/wallet/backtest", json={"records": []}).status_code, 401)

    def test_crud_threshold_validation_backtest_and_audit(self):
        self.login()
        profile = self.client.get("/api/analysis-profiles", params={"domain": "wallet"})
        self.assertEqual(profile.status_code, 200)
        self.assertGreater(len(profile.json()["rows"]), 20)

        update = self.client.put("/api/analysis-profiles/wallet/migration_rate", json={"enabled": True, "threshold": ">= 25%"})
        self.assertEqual(update.status_code, 200)
        self.assertEqual(update.json()["threshold"], ">= 25%")
        invalid = self.client.put("/api/analysis-profiles/wallet/migration_rate", json={"enabled": True, "threshold": ">= 25"})
        self.assertEqual(invalid.status_code, 422)

        created = self.client.post("/api/analysis-profiles/x", json={
            "key": "quality_metric", "label": "Quality", "source": "aggregated.engagementRate",
            "value_type": "percent", "scale": "ratio", "threshold": ">= 2%", "enabled": True,
            "description": "test"
        })
        self.assertEqual(created.status_code, 200)
        toggled = self.client.put("/api/analysis-profiles/x/quality_metric", json={"enabled": False, "threshold": ">= 3%"})
        self.assertEqual(toggled.status_code, 200)
        self.assertFalse(toggled.json()["enabled"])
        deleted = self.client.delete("/api/analysis-profiles/x/quality_metric")
        self.assertEqual(deleted.status_code, 200)

        # Keep a deterministic wallet profile for API backtest.
        all_rows = self.client.get("/api/analysis-profiles", params={"domain": "wallet"}).json()["rows"]
        for row in all_rows:
            if row["enabled"] and row["key"] != "migration_rate":
                self.client.put(f"/api/analysis-profiles/wallet/{row['key']}", json={"enabled": False, "threshold": row["threshold"]})
        result = self.client.post("/api/analysis-profiles/wallet/backtest", json={"records": [{"migrationRate": 0.30}, {"migrationRate": 0.10}, {}]})
        self.assertEqual(result.status_code, 200)
        body = result.json()
        self.assertEqual(body["complete_records"], 2)
        self.assertEqual(body["pass_rate"], 0.5)
        self.assertAlmostEqual(body["coverage"], 2 / 3, places=6)

        audit = self.client.get("/api/audit").json()["rows"]
        actions = {row["action"] for row in audit}
        self.assertTrue({"analysis_parameter_update", "analysis_parameter_create", "analysis_parameter_delete", "analysis_backtest"}.issubset(actions))

    def test_legacy_parameter_enable_is_rejected(self):
        self.login()
        rows = self.client.get("/api/analysis-profiles").json()["rows"]
        legacy = next(row for row in rows if row["runtime_state"] == "legacy")
        response = self.client.put(
            f"/api/analysis-profiles/{legacy['domain']}/{legacy['key']}",
            json={"enabled": True, "threshold": legacy["threshold"]},
        )
        self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()
