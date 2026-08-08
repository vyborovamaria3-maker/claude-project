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
            restored = store.restore_builtin("wallet", "migration_rate", "admin")
            self.assertTrue(restored["enabled"])
            self.assertEqual(restored["threshold"], ">= 37%")

    def test_confirmation_has_no_global_next_request_bypass(self):
        js = (ADMIN_ROOT / "app" / "static" / "analysis-confirm-v5.js").read_text(encoding="utf-8")
        self.assertNotIn("preconfirmedMutation", js)
        self.assertNotIn("clickBypass", js)
        self.assertIn("__analysisConfirmed", js)
        self.assertIn("AdminAnalysisConfirm", js)

    def test_race_guard_is_loaded_before_editor_and_cancel_cleanup_is_loaded(self):
        html = (ADMIN_ROOT / "app" / "static" / "index.html").read_text(encoding="utf-8")
        confirm_pos = html.index('/static/analysis-confirm-v5.js')
        guard_pos = html.index('/static/analysis-ui-guard-v6.js')
        editor_pos = html.index('/static/analysis-profiles-v4.js')
        cancel_pos = html.index('/static/analysis-cancel-silence-v5.js')
        self.assertLess(confirm_pos, guard_pos)
        self.assertLess(guard_pos, editor_pos)
        self.assertGreater(cancel_pos, editor_pos)

    def test_race_guard_handles_toggle_from_server_snapshot_and_blocks_busy_navigation(self):
        js = (ADMIN_ROOT / "app" / "static" / "analysis-ui-guard-v6.js").read_text(encoding="utf-8")
        self.assertIn('snapshot = await jsonRequest', js)
        self.assertIn('row.enabled', js)
        self.assertIn('AdminAnalysisConfirm?.ask', js)
        self.assertIn('__analysisConfirmed: true', js)
        self.assertIn('.analysis-tab[data-domain], #navigation [data-view], #analysisProfilesNav, #refreshButton, #logoutButton', js)
        self.assertIn('loadCount', js)
        self.assertIn('mutationCount', js)
        self.assertIn('if (document.contains(button)) button.disabled = false', js)

    def test_expired_analysis_session_returns_to_login(self):
        js = (ADMIN_ROOT / "app" / "static" / "analysis-ui-guard-v6.js").read_text(encoding="utf-8")
        self.assertIn('response.status === 401', js)
        self.assertIn('typeof window.showLogin === "function"', js)
        self.assertIn('window.showLogin()', js)

    def test_backtest_stays_outside_confirmation_and_busy_mutation_tracking(self):
        confirm = (ADMIN_ROOT / "app" / "static" / "analysis-confirm-v5.js").read_text(encoding="utf-8")
        guard = (ADMIN_ROOT / "app" / "static" / "analysis-ui-guard-v6.js").read_text(encoding="utf-8")
        self.assertIn('endsWith("/backtest")', confirm)
        self.assertIn('const isBacktest = path.endsWith("/backtest")', guard)
        self.assertIn('!isBacktest', guard)


if __name__ == "__main__":
    unittest.main()
