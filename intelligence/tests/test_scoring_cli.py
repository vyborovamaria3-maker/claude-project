from __future__ import annotations

import io
import json
import unittest
from contextlib import redirect_stderr, redirect_stdout

from intelligence.cli import main
from intelligence.providers.github.scoring import DEVELOPER_SCORE_VERSION


class ExplodingRuntimeFactory:
    def __call__(self, path):
        raise AssertionError("backtest must not construct a durable runtime")


class ScoringCLITests(unittest.TestCase):
    def test_backtest_runs_without_database_or_runtime(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = main(["backtest"], runtime_factory=ExplodingRuntimeFactory())

        self.assertEqual(code, 0)
        self.assertEqual(stderr.getvalue(), "")
        payload = json.loads(stdout.getvalue())
        self.assertTrue(payload["all_passed"])
        self.assertEqual(payload["failed"], 0)
        self.assertEqual(payload["score_version"], DEVELOPER_SCORE_VERSION)
        self.assertGreaterEqual(payload["passed"], 4)

    def test_missing_fixture_returns_safe_domain_error(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = main(["backtest", "--fixture", "/definitely/missing/fixture.json"])

        self.assertEqual(code, 2)
        self.assertEqual(stdout.getvalue(), "")
        payload = json.loads(stderr.getvalue())
        self.assertEqual(payload["error"], "failed to load developer score backtest fixture")
        self.assertNotIn("/definitely/missing", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
