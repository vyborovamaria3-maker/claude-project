from __future__ import annotations

import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from fastapi.testclient import TestClient

from app.analysis_editor import LiveAnalysisProfileStore


class AnalysisDatabaseStoreIntegrityTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.tmp.name) / "control.db")
        self.store = LiveAnalysisProfileStore(self.db_path)

    def tearDown(self):
        self.tmp.cleanup()

    def reopen(self) -> LiveAnalysisProfileStore:
        return LiveAnalysisProfileStore(self.db_path)

    def test_successful_builtin_write_is_durable_after_reopen(self):
        self.store.update_builtin("wallet", "migration_rate", enabled=False, threshold=">= 37%", username="admin")
        row = next(r for r in self.reopen().list("wallet") if r["key"] == "migration_rate")
        self.assertFalse(row["enabled"])
        self.assertEqual(row["threshold"], ">= 37%")

    def test_failed_validation_does_not_change_previous_database_state(self):
        self.store.update_builtin("wallet", "migration_rate", enabled=True, threshold=">= 31%", username="admin")
        before = next(r for r in self.reopen().list("wallet") if r["key"] == "migration_rate")
        with self.assertRaises(ValueError):
            self.store.update_builtin("wallet", "migration_rate", enabled=False, threshold=">= 31", username="admin")
        after = next(r for r in self.reopen().list("wallet") if r["key"] == "migration_rate")
        self.assertEqual((after["enabled"], after["threshold"]), (before["enabled"], before["threshold"]))

    def test_custom_create_edit_delete_and_recreate_are_durable(self):
        self.store.create_custom(
            "x", key="db_metric", label="DB Metric", source="aggregated.engagementRate",
            value_type="percent", scale="ratio", threshold=">= 2%", enabled=True,
            description="database integrity", username="admin",
        )
        self.store.edit_custom(
            "x", "db_metric", enabled=False, threshold=">= 3%", label="DB Metric 2",
            source="aggregated.botRatio", value_type="percent", scale="ratio",
            description="edited", username="admin",
        )
        row = next(r for r in self.reopen().list("x") if r["key"] == "db_metric")
        self.assertEqual((row["label"], row["source"], row["threshold"], row["enabled"]),
                         ("DB Metric 2", "aggregated.botRatio", ">= 3%", False))
        self.assertTrue(self.store.delete_custom("x", "db_metric", "admin"))
        self.assertFalse(any(r["key"] == "db_metric" for r in self.reopen().list("x")))
        self.store.create_custom(
            "x", key="db_metric", label="Recreated", source="totalTweets",
            value_type="number", scale="raw", threshold=">= 5", enabled=True,
            description="recreated", username="admin",
        )
        row = next(r for r in self.reopen().list("x") if r["key"] == "db_metric")
        self.assertEqual(row["label"], "Recreated")
        self.assertTrue(row["enabled"])

    def test_hide_restore_preserves_saved_state_on_disk(self):
        self.store.update_builtin("wallet", "migration_rate", enabled=False, threshold=">= 44%", username="admin")
        self.store.hide_builtin("wallet", "migration_rate", "admin")
        hidden = next(r for r in self.reopen().list("wallet") if r["key"] == "migration_rate")
        self.assertTrue(hidden["hidden"])
        self.reopen().restore_builtin("wallet", "migration_rate", "admin")
        restored = next(r for r in self.reopen().list("wallet") if r["key"] == "migration_rate")
        self.assertFalse(restored["hidden"])
        self.assertFalse(restored["enabled"])
        self.assertEqual(restored["threshold"], ">= 44%")

    def test_sqlite_integrity_check_after_full_lifecycle(self):
        self.store.update_builtin("wallet", "migration_rate", enabled=True, threshold=">= 21%", username="admin")
        self.store.hide_builtin("wallet", "migration_rate", "admin")
        self.store.restore_builtin("wallet", "migration_rate", "admin")
        with closing(sqlite3.connect(self.db_path)) as db:
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            count = db.execute("SELECT COUNT(*) FROM analysis_parameter_overrides WHERE domain='wallet' AND key='migration_rate'").fetchone()[0]
            self.assertEqual(count, 1)


class AnalysisDatabaseApiTruthfulnessTest(unittest.TestCase):
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

    def test_audit_db_failure_does_not_report_committed_profile_write_as_failed(self):
        original = self.client.app.state.audit.record

        def fail_audit(**kwargs):
            raise sqlite3.OperationalError("simulated audit database failure")

        self.client.app.state.audit.record = fail_audit
        try:
            response = self.client.put(
                "/api/analysis-profiles/wallet/migration_rate",
                json={"enabled": True, "threshold": ">= 39%"},
            )
            self.assertEqual(response.status_code, 200)
            persisted = self.client.get("/api/analysis-profiles", params={"domain": "wallet"})
            self.assertEqual(persisted.status_code, 200)
            row = next(r for r in persisted.json()["rows"] if r["key"] == "migration_rate")
            self.assertTrue(row["enabled"])
            self.assertEqual(row["threshold"], ">= 39%")
        finally:
            self.client.app.state.audit.record = original

    def test_rejected_api_write_leaves_database_unchanged(self):
        before = self.client.get("/api/analysis-profiles", params={"domain": "wallet"}).json()["rows"]
        old = next(r for r in before if r["key"] == "migration_rate")
        response = self.client.put(
            "/api/analysis-profiles/wallet/migration_rate",
            json={"enabled": not old["enabled"], "threshold": ">= 25"},
        )
        self.assertEqual(response.status_code, 422)
        after = self.client.get("/api/analysis-profiles", params={"domain": "wallet"}).json()["rows"]
        new = next(r for r in after if r["key"] == "migration_rate")
        self.assertEqual((new["enabled"], new["threshold"]), (old["enabled"], old["threshold"]))


if __name__ == "__main__":
    unittest.main()
