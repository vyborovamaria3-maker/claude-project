from __future__ import annotations

import unittest
from datetime import datetime, timezone

from intelligence.errors.exceptions import ScoringError
from intelligence.providers.github.models import RepositorySnapshot
from intelligence.providers.github.normalizer import snapshot_to_document
from intelligence.providers.github.scoring import calculate_developer_score
from intelligence.scoring.github import score_github_document


class ScoringTimeIntegrityTests(unittest.TestCase):
    def _snapshot(self, *, created_at: datetime, updated_at: datetime) -> RepositorySnapshot:
        return RepositorySnapshot(
            name="repo",
            full_name="owner/repo",
            url="https://github.com/owner/repo",
            stars=1,
            forks=1,
            watchers=1,
            contributors=3,
            commits_30d=10,
            issues_open=1,
            pull_requests_open=1,
            releases=1,
            archived=False,
            created_at=created_at,
            updated_at=updated_at,
        )

    def test_future_updated_at_is_rejected_to_prevent_lookahead_bias(self) -> None:
        as_of = datetime(2026, 8, 10, tzinfo=timezone.utc)
        snapshot = self._snapshot(
            created_at=datetime(2025, 1, 1, tzinfo=timezone.utc),
            updated_at=datetime(2026, 8, 11, tzinfo=timezone.utc),
        )
        with self.assertRaisesRegex(ValueError, "after evaluation time"):
            calculate_developer_score(snapshot, now=as_of)

    def test_created_at_after_updated_at_is_rejected(self) -> None:
        as_of = datetime(2026, 8, 10, tzinfo=timezone.utc)
        snapshot = self._snapshot(
            created_at=datetime(2026, 8, 9, tzinfo=timezone.utc),
            updated_at=datetime(2026, 8, 8, tzinfo=timezone.utc),
        )
        with self.assertRaisesRegex(ValueError, "created_at cannot be after updated_at"):
            calculate_developer_score(snapshot, now=as_of)

    def test_derived_scorer_collapses_lookahead_failure_to_domain_error(self) -> None:
        snapshot = self._snapshot(
            created_at=datetime(2025, 1, 1, tzinfo=timezone.utc),
            updated_at=datetime(2026, 8, 11, tzinfo=timezone.utc),
        )
        document = snapshot_to_document(snapshot)
        with self.assertRaises(ScoringError):
            score_github_document(
                document,
                as_of=datetime(2026, 8, 10, tzinfo=timezone.utc),
            )


if __name__ == "__main__":
    unittest.main()
