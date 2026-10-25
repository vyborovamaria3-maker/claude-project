from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
import sys


ADMIN_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ADMIN_ROOT))

from app.analysis_editor import LiveAnalysisProfileStore


class AnalysisReleaseGuardTest(unittest.TestCase):
    def test_repeated_builtin_hide_is_idempotent_and_preserves_saved_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = LiveAnalysisProfileStore(str(Path(tmp) / "control.db"))
            store.update_builtin("wallet", "migration_rate", enabled=True, threshold=">= 37%", username="admin")
            first = store.hide_builtin("wallet", "migration_rate", "admin")
            self.assertTrue(first["hidden"])
            second = store.hide_builtin("wallet", "migration_rate", "admin")
            self.assertTrue(second["hidden"])
            with self.assertRaises(ValueError):
                store.update_builtin("wallet", "migration_rate", enabled=False, threshold=">= 12%", username="admin")
            restored = store.restore_builtin("wallet", "migration_rate", "admin")
            self.assertTrue(restored["enabled"])
            self.assertEqual(restored["threshold"], ">= 37%")

    def test_custom_type_scale_pairs_are_validated(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = LiveAnalysisProfileStore(str(Path(tmp) / "control.db"))
            with self.assertRaises(ValueError):
                store.create_custom(
                    "wallet", key="bad_percent_hours", label="Bad", source="metrics.bad",
                    value_type="percent", scale="hours", threshold=">= 20%", enabled=True,
                    description="", username="admin",
                )
            with self.assertRaises(ValueError):
                store.create_custom(
                    "token", key="bad_bool_millions", label="Bad", source="metrics.bad",
                    value_type="boolean", scale="millions", threshold="true", enabled=True,
                    description="", username="admin",
                )
            good = store.create_custom(
                "wallet", key="good_percent", label="Good", source="metrics.good",
                value_type="percent", scale="ratio", threshold=">= 20%", enabled=True,
                description="", username="admin",
            )
            self.assertEqual(good["scale"], "ratio")

if __name__ == "__main__":
    unittest.main()
