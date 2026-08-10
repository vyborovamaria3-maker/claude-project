from __future__ import annotations

import unittest
from datetime import datetime, timezone

from intelligence.core.hashing import build_document_hash
from intelligence.core.models import IntelligenceDocument
from intelligence.errors.exceptions import NormalizationError, ProviderError
from intelligence.providers.github.models import RepositorySnapshot
from intelligence.providers.github.normalizer import snapshot_to_document
from intelligence.providers.github.provider import GitHubIntelligenceProvider
from intelligence.providers.github.scoring import calculate_developer_score


class FakeGitHubClient:
    def __init__(self) -> None:
        self.rate_limit = type("RateLimit", (), {"remaining": 4999, "reset_epoch": 1234567890})()

    async def get_repository(self, full_name: str):
        return {
            "name": "repo",
            "full_name": full_name,
            "html_url": f"https://github.com/{full_name}",
            "stargazers_count": 5000,
            "forks_count": 250,
            "subscribers_count": 42,
            "open_issues_count": 15,
            "archived": False,
            "created_at": "2024-01-01T00:00:00Z",
            "updated_at": "2026-08-01T00:00:00Z",
        }

    async def get_contributor_count(self, full_name: str):
        return 12

    async def get_recent_commit_count(self, full_name: str):
        return 75

    async def get_open_pull_request_count(self, full_name: str):
        return 5

    async def get_release_count(self, full_name: str):
        return 3

    async def health(self):
        return 17


class FailingHealthClient(FakeGitHubClient):
    async def health(self):
        raise ProviderError("unavailable")


class GitHubProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_collect_normalizes_repository(self) -> None:
        provider = GitHubIntelligenceProvider(client=FakeGitHubClient())
        documents = await provider.collect("owner/repo")

        self.assertEqual(len(documents), 1)
        document = documents[0]
        self.assertEqual(document.source, "github")
        self.assertEqual(document.provider, "github-rest")
        self.assertEqual(document.metrics["contributors"], 12)
        self.assertEqual(document.metrics["commits_30d"], 75)
        self.assertEqual(document.metrics["pull_requests_open"], 5)
        # GitHub's open_issues_count includes pull requests, so 15 - 5 = 10.
        self.assertEqual(document.metrics["issues_open"], 10)
        self.assertIsNotNone(document.raw_hash)
        self.assertEqual(len(document.raw_hash or ""), 64)

    async def test_health_exposes_non_secret_rate_limit_metadata(self) -> None:
        provider = GitHubIntelligenceProvider(client=FakeGitHubClient())
        health = await provider.health()
        self.assertTrue(health.healthy)
        self.assertEqual(health.latency_ms, 17)
        self.assertEqual(health.details["rate_limit_remaining"], 4999)
        self.assertNotIn("token", health.details)
        self.assertNotIn("authorization", health.details)

    async def test_failed_health_becomes_degraded_result(self) -> None:
        provider = GitHubIntelligenceProvider(client=FailingHealthClient())
        health = await provider.health()
        self.assertFalse(health.healthy)
        self.assertEqual(health.details["error"], "unavailable")

    def test_normalize_rejects_other_sources(self) -> None:
        provider = GitHubIntelligenceProvider(client=FakeGitHubClient())
        document = IntelligenceDocument(
            id="1",
            source="web",
            content="x",
            collected_at=datetime.now(timezone.utc),
        )
        with self.assertRaises(NormalizationError):
            provider.normalize(document)


class GitHubScoringTests(unittest.TestCase):
    def test_active_repository_scores_high(self) -> None:
        now = datetime(2026, 8, 10, tzinfo=timezone.utc)
        snapshot = RepositorySnapshot(
            name="repo",
            full_name="owner/repo",
            url="https://github.com/owner/repo",
            stars=10000,
            forks=1000,
            watchers=100,
            contributors=25,
            commits_30d=100,
            issues_open=25,
            pull_requests_open=12,
            releases=6,
            archived=False,
            created_at=datetime(2023, 1, 1, tzinfo=timezone.utc),
            updated_at=datetime(2026, 8, 9, tzinfo=timezone.utc),
        )
        result = calculate_developer_score(snapshot, now=now)
        self.assertGreaterEqual(result.score, 85)
        self.assertIn("active_commit_history", result.reasons)

    def test_archived_stale_repository_scores_low(self) -> None:
        now = datetime(2026, 8, 10, tzinfo=timezone.utc)
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
            archived=True,
            created_at=datetime(2025, 1, 1, tzinfo=timezone.utc),
            updated_at=datetime(2025, 1, 1, tzinfo=timezone.utc),
        )
        result = calculate_developer_score(snapshot, now=now)
        self.assertLessEqual(result.score, 20)
        self.assertIn("archived_repository", result.reasons)

    def test_snapshot_rejects_negative_counters(self) -> None:
        with self.assertRaises(ValueError):
            RepositorySnapshot(
                name="repo",
                full_name="owner/repo",
                url="https://github.com/owner/repo",
                stars=-1,
                forks=0,
                watchers=0,
                contributors=0,
                commits_30d=0,
                issues_open=0,
                pull_requests_open=0,
                releases=0,
                archived=False,
                created_at=datetime.now(timezone.utc),
                updated_at=datetime.now(timezone.utc),
            )

    def test_hash_is_stable_and_source_sensitive(self) -> None:
        now = datetime.now(timezone.utc)
        first = IntelligenceDocument(
            id="a",
            source="github",
            content="same",
            collected_at=now,
            url="https://example.test/a",
            author="owner",
        )
        second = IntelligenceDocument(
            id="b",
            source="reddit",
            content="same",
            collected_at=now,
            url="https://example.test/a",
            author="owner",
        )
        self.assertEqual(build_document_hash(first), build_document_hash(first))
        self.assertNotEqual(build_document_hash(first), build_document_hash(second))


class GitHubNormalizerTests(unittest.TestCase):
    def test_document_contains_no_credentials(self) -> None:
        snapshot = RepositorySnapshot(
            name="repo",
            full_name="owner/repo",
            url="https://github.com/owner/repo",
            stars=1,
            forks=2,
            watchers=3,
            contributors=4,
            commits_30d=5,
            issues_open=6,
            pull_requests_open=7,
            releases=8,
            archived=False,
            created_at=datetime(2025, 1, 1, tzinfo=timezone.utc),
            updated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        )
        document = snapshot_to_document(snapshot)
        serialized = f"{document.content} {document.metrics}".lower()
        self.assertNotIn("authorization", serialized)
        self.assertNotIn("github_token", serialized)
        self.assertNotIn("cookie", serialized)


if __name__ == "__main__":
    unittest.main()
