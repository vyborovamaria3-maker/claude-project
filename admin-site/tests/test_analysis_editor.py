from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
import sys

from fastapi.testclient import TestClient

ADMIN_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ADMIN_ROOT))

from app.analysis_editor import LiveAnalysisProfileStore


class AnalysisEditorStoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = LiveAnalysisProfileStore(str(Path(self.tmp.name) / "control.db"))

    def tearDown(self):
        self.tmp.cleanup()

    def test_builtin_hide_restore_preserves_user_configuration(self):
        edited = self.store.update_builtin(
            "wallet", "migration_rate", enabled=True, threshold=">= 33%", username="admin"
        )
        self.assertEqual(edited["threshold"], ">= 33%")
        hidden = self.store.hide_builtin("wallet", "migration_rate", "admin")
        self.assertTrue(hidden["hidden"])
        self.assertFalse(hidden["enabled"])
        self.assertFalse(hidden["rule_active"])
        restored = self.store.restore_builtin("wallet", "migration_rate", "admin")
        self.assertFalse(restored["hidden"])
        self.assertTrue(restored["enabled"])
        self.assertEqual(restored["threshold"], ">= 33%")
        self.assertTrue(restored["rule_active"])

    def test_builtin_disabled_state_survives_hide_restore(self):
        self.store.update_builtin("wallet", "migration_rate", enabled=False, threshold=">= 41%", username="admin")
        self.store.hide_builtin("wallet", "migration_rate", "admin")
        restored = self.store.restore_builtin("wallet", "migration_rate", "admin")
        self.assertFalse(restored["enabled"])
        self.assertEqual(restored["threshold"], ">= 41%")
        self.assertFalse(restored["rule_active"])

    def test_custom_parameter_can_be_fully_edited(self):
        created = self.store.create_custom(
            "token", key="custom_velocity", label="Velocity", source="metrics.velocity",
            value_type="number", scale="raw", threshold=">= 10", enabled=True,
            description="old", username="admin",
        )
        self.assertTrue(created["custom"])
        edited = self.store.edit_custom(
            "token", "custom_velocity", enabled=False, threshold="<= 25",
            label="Velocity 2", source="metrics.velocity2", value_type="score",
            scale="raw", description="new", username="admin",
        )
        self.assertEqual(edited["label"], "Velocity 2")
        self.assertEqual(edited["source"], "metrics.velocity2")
        self.assertEqual(edited["type"], "score")
        self.assertEqual(edited["threshold"], "<= 25")
        self.assertFalse(edited["enabled"])
        self.assertEqual(edited["description"], "new")

    def test_invalid_custom_edits_are_rejected_without_corrupting_row(self):
        self.store.create_custom(
            "x", key="custom_velocity", label="Velocity", source="metrics.velocity",
            value_type="number", scale="raw", threshold=">= 10", enabled=True,
            description="safe", username="admin",
        )
        for kwargs in (
            dict(source="bad path", value_type="number", scale="raw", threshold=">= 10"),
            dict(source="metrics.velocity", value_type="wat", scale="raw", threshold=">= 10"),
            dict(source="metrics.velocity", value_type="number", scale="wat", threshold=">= 10"),
            dict(source="metrics.velocity", value_type="number", scale="raw", threshold="not-a-number"),
        ):
            with self.assertRaises(ValueError):
                self.store.edit_custom(
                    "x", "custom_velocity", enabled=True, label="Velocity",
                    description="safe", username="admin", **kwargs,
                )
        row = next(item for item in self.store.list("x") if item["key"] == "custom_velocity")
        self.assertEqual(row["source"], "metrics.velocity")
        self.assertEqual(row["threshold"], ">= 10")


class AnalysisEditorApiTest(unittest.TestCase):
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
        login = self.client.post("/api/login", json={"username": "admin", "password": "correct-password"})
        self.assertEqual(login.status_code, 200)

    def tearDown(self):
        self.client.close()
        os.environ.clear()
        os.environ.update(self.old_env)
        self.tmp.cleanup()

    def row(self, domain: str, key: str):
        response = self.client.get("/api/analysis-profiles", params={"domain": domain})
        self.assertEqual(response.status_code, 200)
        return next(item for item in response.json()["rows"] if item["key"] == key)

    def test_complete_builtin_user_flow_edit_toggle_hide_restore_and_backtest(self):
        edit = self.client.patch(
            "/api/analysis-profiles/wallet/migration_rate/editor",
            json={"enabled": True, "threshold": ">= 33%"},
        )
        self.assertEqual(edit.status_code, 200)
        self.assertEqual(edit.json()["threshold"], ">= 33%")

        off = self.client.put(
            "/api/analysis-profiles/wallet/migration_rate",
            json={"enabled": False, "threshold": ">= 33%"},
        )
        self.assertEqual(off.status_code, 200)
        self.assertFalse(off.json()["enabled"])

        on = self.client.put(
            "/api/analysis-profiles/wallet/migration_rate",
            json={"enabled": True, "threshold": ">= 33%"},
        )
        self.assertEqual(on.status_code, 200)
        self.assertTrue(on.json()["rule_active"])

        before = self.client.post(
            "/api/analysis-profiles/wallet/backtest",
            json={
                "contract": "wallet.creator_summary",
                "records": [
                    {"migrationRate": 0.40, "rate300k": 0.20, "riskScore": 20, "rugRate": 0.10, "successRate": 0.30},
                    {"migrationRate": 0.25, "rate300k": 0.20, "riskScore": 20, "rugRate": 0.10, "successRate": 0.30},
                ],
            },
        )
        self.assertEqual(before.status_code, 200)
        self.assertEqual(before.json()["coverage"], 1.0)
        self.assertEqual(before.json()["pass_rate"], 0.5)

        hidden = self.client.delete("/api/analysis-profiles/wallet/migration_rate/entry")
        self.assertEqual(hidden.status_code, 200)
        self.assertTrue(hidden.json()["hidden"])
        self.assertTrue(self.row("wallet", "migration_rate")["hidden"])

        restored = self.client.post("/api/analysis-profiles/wallet/migration_rate/restore")
        self.assertEqual(restored.status_code, 200)
        self.assertEqual(restored.json()["threshold"], ">= 33%")
        self.assertTrue(restored.json()["enabled"])

        after = self.client.post(
            "/api/analysis-profiles/wallet/backtest",
            json={
                "contract": "wallet.creator_summary",
                "records": [
                    {"migrationRate": 0.40, "rate300k": 0.20, "riskScore": 20, "rugRate": 0.10, "successRate": 0.30},
                    {"migrationRate": 0.25, "rate300k": 0.20, "riskScore": 20, "rugRate": 0.10, "successRate": 0.30},
                ],
            },
        )
        self.assertEqual(after.status_code, 200)
        self.assertEqual(after.json()["pass_rate"], before.json()["pass_rate"])

    def test_system_schema_cannot_be_mutated(self):
        for field, value in (
            ("source", "evil.path"), ("label", "Fake"), ("value_type", "text"),
            ("scale", "days"), ("description", "replace schema"),
        ):
            payload = {"enabled": True, "threshold": ">= 20%", field: value}
            response = self.client.patch("/api/analysis-profiles/wallet/migration_rate/editor", json=payload)
            self.assertEqual(response.status_code, 422, (field, response.text))
        row = self.row("wallet", "migration_rate")
        self.assertEqual(row["source"], "migrationRate")
        self.assertEqual(row["type"], "percent")

    def test_custom_user_flow_create_edit_backtest_delete_recreate(self):
        created = self.client.post(
            "/api/analysis-profiles/x",
            json={"key":"custom_velocity","label":"Velocity","source":"metrics.velocity","value_type":"number","scale":"raw","threshold":">= 10","enabled":True,"description":"old"},
        )
        self.assertEqual(created.status_code, 200)
        self.assertTrue(created.json()["rule_active"])

        passed = self.client.post(
            "/api/analysis-profiles/x/backtest",
            json={"contract":"x.custom","records":[{"metrics":{"velocity":12}},{"metrics":{"velocity":8}}]},
        )
        self.assertEqual(passed.status_code, 200)
        self.assertEqual(passed.json()["coverage"], 1.0)
        self.assertEqual(passed.json()["pass_rate"], 0.5)

        edited = self.client.patch(
            "/api/analysis-profiles/x/custom_velocity/editor",
            json={"enabled":True,"threshold":"<= 20","label":"Velocity 2","source":"metrics.velocity2","value_type":"score","scale":"raw","description":"new"},
        )
        self.assertEqual(edited.status_code, 200)
        self.assertEqual(edited.json()["label"], "Velocity 2")
        self.assertEqual(edited.json()["source"], "metrics.velocity2")
        self.assertEqual(edited.json()["type"], "score")

        passed2 = self.client.post(
            "/api/analysis-profiles/x/backtest",
            json={"contract":"x.custom","records":[{"metrics":{"velocity2":12}},{"metrics":{"velocity2":30}}]},
        )
        self.assertEqual(passed2.status_code, 200)
        self.assertEqual(passed2.json()["pass_rate"], 0.5)

        deleted = self.client.delete("/api/analysis-profiles/x/custom_velocity/entry")
        self.assertEqual(deleted.status_code, 200)
        self.assertTrue(deleted.json()["deleted"])
        rows = self.client.get("/api/analysis-profiles", params={"domain": "x"}).json()["rows"]
        self.assertFalse(any(item["key"] == "custom_velocity" for item in rows))

        recreated = self.client.post(
            "/api/analysis-profiles/x",
            json={"key":"custom_velocity","label":"Velocity Again","source":"metrics.velocity","value_type":"number","scale":"raw","threshold":">= 5","enabled":True,"description":"recreated"},
        )
        self.assertEqual(recreated.status_code, 200)
        self.assertEqual(recreated.json()["label"], "Velocity Again")

    def test_invalid_inputs_are_rejected_across_editor(self):
        bad_percent = self.client.patch(
            "/api/analysis-profiles/wallet/migration_rate/editor",
            json={"enabled": True, "threshold": ">= 50"},
        )
        self.assertEqual(bad_percent.status_code, 422)

        legacy = self.client.patch(
            "/api/analysis-profiles/token/solscan_holder_count/editor",
            json={"enabled": True, "threshold": ">= 10"},
        )
        self.assertEqual(legacy.status_code, 422)

        object_rule = self.client.patch(
            "/api/analysis-profiles/token/social_engagements/editor",
            json={"enabled": True, "threshold": ">= 1"},
        )
        self.assertEqual(object_rule.status_code, 422)

        bad_custom = self.client.post(
            "/api/analysis-profiles/telegram",
            json={"key":"bad_custom","label":"Bad","source":"bad source","value_type":"number","scale":"raw","threshold":">= 1","enabled":True,"description":""},
        )
        self.assertEqual(bad_custom.status_code, 422)

    def test_audit_records_mutating_user_flow(self):
        self.client.patch(
            "/api/analysis-profiles/wallet/migration_rate/editor",
            json={"enabled": True, "threshold": ">= 31%"},
        )
        self.client.delete("/api/analysis-profiles/wallet/migration_rate/entry")
        self.client.post("/api/analysis-profiles/wallet/migration_rate/restore")
        audit = self.client.get("/api/audit", params={"limit": 100})
        self.assertEqual(audit.status_code, 200)
        text = audit.text
        self.assertIn("analysis_parameter_live_edit", text)
        self.assertIn("analysis_parameter_hide", text)
        self.assertIn("analysis_parameter_restore", text)


if __name__ == "__main__":
    unittest.main()
