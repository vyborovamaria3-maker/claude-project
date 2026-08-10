from __future__ import annotations

import unittest
from datetime import datetime, timezone

from intelligence.core.models import IntelligenceDocument
from intelligence.errors.exceptions import ScoringError
from intelligence.providers.github.models import RepositorySnapshot
from intelligence.providers.github.normalizer import snapshot_to_document
from intelligence.providers.github.scoring import calculate_developer_score
from intelligence.scoring.github import score_github_document, snapshot_from_github_document


class DerivedGitHubScoringTests(unittest.TestCase):
    def setUp(self) -> None:
        self.as_of = datetime(2026, 8, 10, tzinfo=timezone.utc)
        self.snapshot = RepositorySnapshot(
            name="repo",
            full_name="owner/repo",
            url="https://github.com/owner/repo",
            stars=1000,
            forks=100,
            watchers=25,
            contributors=8,
            commits_30d=45,
            issues_open=6,
            pull_requests_open=3,
            releases=2,
            archived=False,
            created_at=datetime(2024, 1, 1, tzinfo=timezone.utc),
            updated_at=datetime(2026, 8, 8, tzinfo=timezone.utc),
        )
        self.document = snapshot_to_document(self.snapshot)

    def test_persisted_document_reconstructs_snapshot(self) -> None:
        reconstructed = snapshot_from_github_document(self.document)
        self.assertEqual(reconstructed.full_name, self.snapshot.full_name)
        self.assertEqual(reconstructed.commits_30d, self.snapshot.commits_30d)
        self.assertEqual(reconstructed.created_at, self.snapshot.created_at)

    def test_document_score_matches_direct_snapshot_score(self) -> None:
        direct = calculate_developer_score(self.snapshot, now=self.as_of)
        derived = score_github_document(self.document, as_of=self.as_of)
        self.assertEqual(derived, direct)

    def test_scoring_does_not_mutate_document_or_raw_hash(self) -> None:
        before_metrics = dict(self.document.metrics)
        before_hash = self.document.raw_hash
        score_github_document(self.document, as_of=self.as_of)
        self.assertEqual(self.document.metrics, before_metrics)
        self.assertEqual(self.document.raw_hash, before_hash)

    def test_non_github_document_is_rejected(self) -> None:
        document = IntelligenceDocument(
            id="x",
            source="web",
            content="evidence",
            collected_at=self.as_of,
        )
        with self.assertRaises(ScoringError):
            score_github_document(document, as_of=self.as_of)

    def test_missing_repository_entity_is_rejected(self) -> None:
        self.document.entities = ["repository"]
        with self.assertRaisesRegex(ScoringError, "repository entity"):
            score_github_document(self.document, as_of=self.as_of)

    def test_boolean_counter_is_rejected(self) -> None:
        self.document.metrics["commits_30d"] = True
        with self.assertRaisesRegex(ScoringError, "commits_30d"):
            score_github_document(self.document, as_of=self.as_of)

    def test_naive_persisted_timestamp_is_rejected(self) -> None:
        self.document.metrics["updated_at"] = "2026-08-08T00:00:00"
        with self.assertRaisesRegex(ScoringError, "timezone"):
            score_github_document(self.document, as_of=self.as_of)

    def test_naive_as_of_is_collapsed_to_scoring_error(self) -> None:
        with self.assertRaises(ScoringError):
            score_github_document(self.document, as_of=datetime(2026, 8, 10))


if __name__ == "__main__":
    unittest.main()
