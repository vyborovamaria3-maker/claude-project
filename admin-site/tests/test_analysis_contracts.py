from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
import sys

from fastapi.testclient import TestClient

ADMIN_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ADMIN_ROOT))

from app.analysis_contracts import enriched_builtin
from app.analysis_profiles_v3 import ContractAwareAnalysisProfileStore


class AnalysisContractUnitTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = ContractAwareAnalysisProfileStore(str(Path(self.tmp.name) / "control.db"))

    def tearDown(self):
        self.tmp.cleanup()

    def test_known_schema_mismatches_are_corrected(self):
        social = enriched_builtin("token", "social_engagements")
        self.assertEqual(social["type"], "object")
        self.assertFalse(social["rule_capable"])
        explicit = enriched_builtin("telegram", "explicit_call")
        self.assertEqual(explicit["source"], "explicit_call")
        for key in ("confidence", "early_rate", "roi_component"):
            row = enriched_builtin("telegram", key)
            self.assertEqual(row["runtime_state"], "derived")
            self.assertEqual(row["contract"], "telegram.derived")

    def test_selected_is_not_the_same_as_active_rule(self):
        rows = self.store.list("wallet")
        selected_without_rule = next(row for row in rows if row["key"] == "total_tokens_created")
        self.assertTrue(selected_without_rule["enabled"])
        self.assertFalse(selected_without_rule["rule_active"])
        migration = next(row for row in rows if row["key"] == "migration_rate")
        self.assertTrue(migration["enabled"])
        self.assertTrue(migration["rule_active"])

    def test_display_only_object_rejects_threshold(self):
        with self.assertRaisesRegex(ValueError, "display-only"):
            self.store.update_builtin(
                "token", "social_engagements", enabled=True, threshold=">= 1", username="admin"
            )
        row = self.store.update_builtin(
            "token", "social_engagements", enabled=True, threshold="", username="admin"
        )
        self.assertTrue(row["enabled"])
        self.assertFalse(row["rule_active"])

    def test_default_rules_are_contract_consistent(self):
        expected = {
            "wallet": {"wallet.creator_summary"},
            "telegram": {"telegram.channel"},
            "x": {"x.dev_twitter"},
        }
        for domain, contracts in expected.items():
            active = {row["contract"] for row in self.store.list(domain) if row["rule_active"]}
            self.assertEqual(active, contracts)

    def test_mixed_contract_backtest_requires_explicit_contract(self):
        self.store.update_builtin(
            "wallet", "optimal_launch_time", enabled=True, threshold="true", username="admin"
        )
        with self.assertRaisesRegex(ValueError, "Multiple data contracts"):
            self.store.backtest("wallet", [{"migrationRate": 0.4, "riskScore": 20}])

        creator = self.store.backtest(
            "wallet",
            [{"migrationRate": 0.4, "rate300k": 0.2, "riskScore": 20, "rugRate": 0.1, "successRate": 0.3}],
            contract="wallet.creator_summary",
        )
        self.assertEqual(creator["contract"], "wallet.creator_summary")
        self.assertEqual(creator["coverage"], 1.0)

        forensics = self.store.backtest(
            "wallet", [{"isOptimalLaunchTime": True}], contract="wallet.forensics"
        )
        self.assertEqual(forensics["enabled_thresholds"], 1)
        self.assertEqual(forensics["pass_rate"], 1.0)

    def test_wrong_contract_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Unknown backtest contract"):
            self.store.backtest("x", [], contract="wallet.creator_summary")


class AnalysisContractApiTest(unittest.TestCase):
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
        response = self.client.post("/api/login", json={"username": "admin", "password": "correct-password"})
        self.assertEqual(response.status_code, 200)

    def tearDown(self):
        self.client.close()
        os.environ.clear()
        os.environ.update(self.old_env)
        self.tmp.cleanup()

    def test_api_exposes_selected_rules_contracts_and_correct_types(self):
        response = self.client.get("/api/analysis-profiles", params={"domain": "token"})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertIn("selected", body["counts"]["token"])
        self.assertIn("rules", body["counts"]["token"])
        social = next(row for row in body["rows"] if row["key"] == "social_engagements")
        self.assertEqual(social["type"], "object")
        self.assertFalse(social["rule_capable"])

    def test_api_backtest_contract_is_respected(self):
        response = self.client.post(
            "/api/analysis-profiles/wallet/backtest",
            json={
                "contract": "wallet.creator_summary",
                "records": [{"migrationRate": 0.4, "rate300k": 0.2, "riskScore": 20, "rugRate": 0.1, "successRate": 0.3}],
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["contract"], "wallet.creator_summary")
        self.assertEqual(response.json()["coverage"], 1.0)


if __name__ == "__main__":
    unittest.main()
