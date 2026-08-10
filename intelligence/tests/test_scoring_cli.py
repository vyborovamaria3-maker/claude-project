from __future__ import annotations

import io
import json
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone

from intelligence.bootstrap import IntelligenceRuntime
from intelligence.cli import main
from intelligence.core.hashing import build_document_hash
from intelligence.providers.github.models import RepositorySnapshot
from intelligence.providers.github.normalizer import snapshot_to_document
from intelligence.providers.github.scoring import DEVELOPER_SCORE_VERSION
from intelligence.providers.registry import ProviderRegistry
from intelligence.storage.memory_store import MemoryDocumentStore
from intelligence.worker.jobs import IntelligenceWorker
from intelligence.worker.queue import MemoryJobQueue


class ExplodingRuntimeFactory:
    def __call__(self, path):
        raise AssertionError("backtest must not construct a durable runtime")


class RuntimeFactory:
    def __init__(self) -> None:
        self.queue = MemoryJobQueue()
        self.store = MemoryDocumentStore()
        self.registry = ProviderRegistry([])
        self.runtime = IntelligenceRuntime(
            registry=self.registry,
            queue=self.queue,
            store=self.store,
            worker=IntelligenceWorker(self.queue, self.registry, self.store),
        )

    def __call__(self, path):
        return self.runtime


class ScoringCLITests(unittest.TestCase):
    def run_cli(self, argv, factory=None):
        stdout = io.StringIO()
        stderr = io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = main(argv, runtime_factory=factory)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_backtest_runs_without_database_or_runtime(self) -> None:
        code, stdout, stderr = self.run_cli(["backtest"], ExplodingRuntimeFactory())
        self.assertEqual(code, 0)
        self.assertEqual(stderr, "")
        payload = json.loads(stdout)
        self.assertTrue(payload["all_passed"])
        self.assertEqual(payload["failed"], 0)
        self.assertEqual(payload["score_version"], DEVELOPER_SCORE_VERSION)
        self.assertGreaterEqual(payload["passed"], 4)

    def test_missing_fixture_returns_safe_domain_error(self) -> None:
        code, stdout, stderr = self.run_cli(
            ["backtest", "--fixture", "/definitely/missing/fixture.json"]
        )
        self.assertEqual(code, 2)
        self.assertEqual(stdout, "")
        payload = json.loads(stderr)
        self.assertEqual(payload["error"], "failed to load developer score backtest fixture")
        self.assertNotIn("/definitely/missing", stderr)

    def test_score_reads_persisted_github_document_without_exposing_evidence(self) -> None:
        factory = RuntimeFactory()
        snapshot = RepositorySnapshot(
            name="repo",
            full_name="owner/repo",
            url="https://github.com/owner/repo",
            stars=1000,
            forks=100,
            watchers=20,
            contributors=10,
            commits_30d=60,
            issues_open=8,
            pull_requests_open=4,
            releases=2,
            archived=False,
            created_at=datetime(2024, 1, 1, tzinfo=timezone.utc),
            updated_at=datetime(2026, 8, 9, tzinfo=timezone.utc),
        )
        document = snapshot_to_document(snapshot)
        document.content += " token=content-secret"
        document.metrics["debug_token"] = "metrics-secret"
        document.raw_hash = build_document_hash(document)
        factory.store.save(document)

        code, stdout, stderr = self.run_cli(
            ["score", document.id, "--as-of", "2026-08-10T00:00:00+00:00"],
            factory,
        )
        self.assertEqual(code, 0)
        self.assertEqual(stderr, "")
        payload = json.loads(stdout)
        self.assertEqual(payload["document_id"], document.id)
        self.assertEqual(payload["score_version"], DEVELOPER_SCORE_VERSION)
        self.assertIsInstance(payload["score"], int)
        self.assertEqual(payload["as_of"], "2026-08-10T00:00:00+00:00")
        self.assertNotIn("content-secret", stdout)
        self.assertNotIn("metrics-secret", stdout)
        self.assertNotIn("metrics", payload)
        self.assertNotIn("url", payload)

    def test_score_missing_document_returns_bounded_error(self) -> None:
        code, stdout, stderr = self.run_cli(
            ["score", "missing", "--as-of", "2026-08-10T00:00:00+00:00"],
            RuntimeFactory(),
        )
        self.assertEqual(code, 1)
        self.assertEqual(stdout, "")
        self.assertEqual(json.loads(stderr), {"error": "document_not_found"})

    def test_score_rejects_naive_as_of(self) -> None:
        factory = RuntimeFactory()
        snapshot = RepositorySnapshot(
            name="repo",
            full_name="owner/repo",
            url="https://github.com/owner/repo",
            stars=0,
            forks=0,
            watchers=0,
            contributors=1,
            commits_30d=0,
            issues_open=0,
            pull_requests_open=0,
            releases=0,
            archived=False,
            created_at=datetime(2025, 1, 1, tzinfo=timezone.utc),
            updated_at=datetime(2025, 1, 1, tzinfo=timezone.utc),
        )
        document = snapshot_to_document(snapshot)
        factory.store.save(document)

        code, _, stderr = self.run_cli(
            ["score", document.id, "--as-of", "2026-08-10T00:00:00"],
            factory,
        )
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(stderr)["error"], "as-of must include a timezone")

    def test_score_rejects_noncanonical_github_url(self) -> None:
        factory = RuntimeFactory()
        snapshot = RepositorySnapshot(
            name="repo",
            full_name="owner/repo",
            url="https://github.com/owner/repo",
            stars=0,
            forks=0,
            watchers=0,
            contributors=1,
            commits_30d=0,
            issues_open=0,
            pull_requests_open=0,
            releases=0,
            archived=False,
            created_at=datetime(2025, 1, 1, tzinfo=timezone.utc),
            updated_at=datetime(2025, 1, 1, tzinfo=timezone.utc),
        )
        document = snapshot_to_document(snapshot)
        document.url = "https://github.com/owner/repo?token=bad"
        document.raw_hash = build_document_hash(document)
        factory.store.save(document)
        code, stdout, stderr = self.run_cli(
            ["score", document.id, "--as-of", "2026-08-10T00:00:00+00:00"],
            factory,
        )
        self.assertEqual(code, 2)
        self.assertEqual(stdout, "")
        self.assertEqual(json.loads(stderr)["error"], "GitHub repository URL is invalid")
        self.assertNotIn("token=bad", stderr)


if __name__ == "__main__":
    unittest.main()
