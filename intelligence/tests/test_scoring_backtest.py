from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from intelligence.providers.github.models import RepositorySnapshot
from intelligence.providers.github.scoring import (
    DEVELOPER_SCORE_VERSION,
    calculate_developer_score,
)
from intelligence.scoring.backtest import run_developer_score_backtest


class DeveloperScoreBacktestTests(unittest.TestCase):
    def test_golden_fixture_passes_all_cases(self) -> None:
        report = run_developer_score_backtest()
        self.assertTrue(report.all_passed)
        self.assertEqual(report.failed, 0)
        self.assertGreaterEqual(report.passed, 4)
        self.assertEqual(report.score_version, DEVELOPER_SCORE_VERSION)
        self.assertTrue(all(case.passed for case in report.cases))

    def test_score_result_exposes_version(self) -> None:
        snapshot = RepositorySnapshot(
            name="repo",
            full_name="owner/repo",
            url="https://github.com/owner/repo",
            stars=1,
            forks=1,
            watchers=1,
            contributors=3,
            commits_30d=30,
            issues_open=2,
            pull_requests_open=1,
            releases=1,
            archived=False,
            created_at=datetime(2025, 1, 1, tzinfo=timezone.utc),
            updated_at=datetime(2026, 8, 9, tzinfo=timezone.utc),
        )
        result = calculate_developer_score(
            snapshot,
            now=datetime(2026, 8, 10, tzinfo=timezone.utc),
        )
        self.assertEqual(result.version, DEVELOPER_SCORE_VERSION)

    def test_naive_now_is_rejected(self) -> None:
        snapshot = RepositorySnapshot(
            name="repo",
            full_name="owner/repo",
            url="https://github.com/owner/repo",
            stars=0,
            forks=0,
            watchers=0,
            contributors=0,
            commits_30d=0,
            issues_open=0,
            pull_requests_open=0,
            releases=0,
            archived=False,
            created_at=datetime(2025, 1, 1, tzinfo=timezone.utc),
            updated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        )
        with self.assertRaises(ValueError):
            calculate_developer_score(snapshot, now=datetime(2026, 8, 10))

    def _write_fixture(self, payload: dict) -> Path:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "fixture.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def _base_case(self) -> dict:
        return {
            "name": "case",
            "as_of": "2026-08-10T00:00:00+00:00",
            "snapshot": {
                "name": "repo",
                "full_name": "owner/repo",
                "url": "https://github.com/owner/repo",
                "stars": 0,
                "forks": 0,
                "watchers": 0,
                "contributors": 1,
                "commits_30d": 0,
                "issues_open": 0,
                "pull_requests_open": 0,
                "releases": 0,
                "archived": False,
                "created_at": "2025-01-01T00:00:00+00:00",
                "updated_at": "2025-01-01T00:00:00+00:00"
            },
            "expected": {
                "min_score": 0,
                "max_score": 100,
                "required_reasons": []
            }
        }

    def test_fixture_score_version_must_match_runtime(self) -> None:
        payload = {
            "fixture_version": "fixture-v1",
            "score_version": "wrong-version",
            "cases": [self._base_case()],
        }
        with self.assertRaises(ValueError):
            run_developer_score_backtest(self._write_fixture(payload))

    def test_archived_must_be_real_boolean(self) -> None:
        case = self._base_case()
        case["snapshot"]["archived"] = "false"
        payload = {
            "fixture_version": "fixture-v1",
            "score_version": DEVELOPER_SCORE_VERSION,
            "cases": [case],
        }
        with self.assertRaisesRegex(ValueError, "archived must be a boolean"):
            run_developer_score_backtest(self._write_fixture(payload))

    def test_duplicate_case_names_are_rejected(self) -> None:
        first = self._base_case()
        second = self._base_case()
        payload = {
            "fixture_version": "fixture-v1",
            "score_version": DEVELOPER_SCORE_VERSION,
            "cases": [first, second],
        }
        with self.assertRaisesRegex(ValueError, "duplicate backtest case name"):
            run_developer_score_backtest(self._write_fixture(payload))


if __name__ == "__main__":
    unittest.main()
