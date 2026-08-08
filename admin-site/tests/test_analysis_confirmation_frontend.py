from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "app" / "static"


class AnalysisConfirmationFrontendContractTest(unittest.TestCase):
    def test_confirmation_script_loads_before_editor(self):
        html = (STATIC / "index.html").read_text(encoding="utf-8")
        confirm_pos = html.index('/static/analysis-confirm-v5.js')
        editor_pos = html.index('/static/analysis-profiles-v4.js')
        self.assertLess(confirm_pos, editor_pos)
        self.assertIn('/static/analysis-confirm-v5.css', html)

    def test_all_mutating_methods_are_guarded_and_backtest_is_not(self):
        js = (STATIC / "analysis-confirm-v5.js").read_text(encoding="utf-8")
        for method in ('POST', 'PUT', 'PATCH', 'DELETE'):
            self.assertIn(f'"{method}"', js)
        self.assertIn('/api/analysis-profiles/', js)
        self.assertIn('url.endsWith("/backtest")', js)
        self.assertIn('До подтверждения запрос на сервер не отправляется', js)

    def test_confirmation_has_cancel_confirm_and_destructive_copy(self):
        js = (STATIC / "analysis-confirm-v5.js").read_text(encoding="utf-8")
        self.assertIn('Подтвердить', js)
        self.assertIn('Отмена', js)
        self.assertIn('Да, удалить', js)
        self.assertIn('audit trail', js)
        self.assertIn('ON → OFF', js)
        self.assertIn('OFF → ON', js)

    def test_editor_exposes_all_user_actions(self):
        js = (STATIC / "analysis-profiles-v4.js").read_text(encoding="utf-8")
        for marker in (
            'analysisEditorSave',
            'analysisEditorDelete',
            'analysisEditorRestore',
            'analysisCreate',
            'analysisRunBacktest',
            'data-toggle',
            'data-edit',
            'data-row',
        ):
            self.assertIn(marker, js)

    def test_confirmation_css_is_mobile_aware(self):
        css = (STATIC / "analysis-confirm-v5.css").read_text(encoding="utf-8")
        self.assertIn('@media(max-width:560px)', css)
        self.assertIn('analysis-confirm-danger', css)
        self.assertIn('var(--panel-2)', css)


if __name__ == '__main__':
    unittest.main()
