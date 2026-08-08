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

    def test_builtin_can_be_hidden_and_restored_without_deleting_catalog(self):
        hidden = self.store.hide_builtin("wallet", "migration_rate", "admin")
        self.assertTrue(hidden["hidden"])
        self.assertFalse(hidden["enabled"])
        self.assertFalse(hidden["rule_active"])
        restored = self.store.restore_builtin("wallet", "migration_rate", "admin")
        self.assertFalse(restored["hidden"])
        self.assertTrue(restored["enabled"])
        self.assertEqual(restored["threshold"], ">= 20%")

    def test_custom_parameter_can_be_fully_edited(self):
        created = self.store.create_custom(
            "token",
            key="custom_velocity",
            label="Velocity",
            source="metrics.velocity",
            value_type="number",
            scale="raw",
            threshold=">= 10",
            enabled=True,
            description="old",
            username="admin",
        )
        self.assertTrue(created["custom"])
        edited = self.store.edit_custom(
            "token",
            "custom_velocity",
            enabled=False,
            threshold="<= 25",
            label="Velocity 2",
            source="metrics.velocity2",
            value_type="score",
            scale="raw",
            description="new",
            username="admin",
        )
        self.assertEqual(edited["label"], "Velocity 2")
        self.assertEqual(edited["source"], "metrics.velocity2")
        self.assertEqual(edited["type"], "score")
        self.assertEqual(edited["threshold"], "<= 25")
        self.assertFalse(edited["enabled"])
        self.assertEqual(edited["description"], "new")


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

    def test_builtin_live_edit_and_hide_restore(self):
        edit = self.client.patch(
            "/api/analysis-profiles/wallet/migration_rate/editor",
            json={"enabled": True, "threshold": ">= 33%"},
        )
        self.assertEqual(edit.status_code, 200)
        self.assertEqual(edit.json()["threshold"], ">= 33%")

        immutable = self.client.patch(
            "/api/analysis-profiles/wallet/migration_rate/editor",
            json={"enabled": True, "threshold": ">= 33%", "source": "evil.path"},
        )
        self.assertEqual(immutable.status_code, 422)

        hidden = self.client.delete("/api/analysis-profiles/wallet/migration_rate/entry")
        self.assertEqual(hidden.status_code, 200)
        self.assertTrue(hidden.json()["hidden"])
        rows = self.client.get("/api/analysis-profiles", params={"domain": "wallet"}).json()["rows"]
        row = next(item for item in rows if item["key"] == "migration_rate")
        self.assertTrue(row["hidden"])
        self.assertFalse(row["enabled"])

        restored = self.client.post("/api/analysis-profiles/wallet/migration_rate/restore")
        self.assertEqual(restored.status_code, 200)
        self.assertFalse(restored.json()["hidden"])

    def test_custom_full_edit_then_delete(self):
        created = self.client.post(
            "/api/analysis-profiles/x",
            json={
                "key": "custom_velocity",
                "label": "Velocity",
                "source": "metrics.velocity",
                "value_type": "number",
                "scale": "raw",
                "threshold": ">= 10",
                "enabled": True,
                "description": "old",
            },
        )
        self.assertEqual(created.status_code, 200)
        edited = self.client.patch(
            "/api/analysis-profiles/x/custom_velocity/editor",
            json={
                "enabled": False,
                "threshold": "<= 20",
                "label": "Velocity 2",
                "source": "metrics.velocity2",
                "value_type": "score",
                "scale": "raw",
                "description": "new",
            },
        )
        self.assertEqual(edited.status_code, 200)
        self.assertEqual(edited.json()["label"], "Velocity 2")
        self.assertEqual(edited.json()["source"], "metrics.velocity2")
        deleted = self.client.delete("/api/analysis-profiles/x/custom_velocity/entry")
        self.assertEqual(deleted.status_code, 200)
        self.assertTrue(deleted.json()["deleted"])
        rows = self.client.get("/api/analysis-profiles", params={"domain": "x"}).json()["rows"]
        self.assertFalse(any(item["key"] == "custom_velocity" for item in rows))


if __name__ == "__main__":
    unittest.main()
