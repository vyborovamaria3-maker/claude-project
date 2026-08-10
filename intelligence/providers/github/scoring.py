"""Developer activity scoring for GitHub repository snapshots."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from intelligence.providers.github.models import RepositorySnapshot


@dataclass(frozen=True, slots=True)
class DeveloperScore:
    score: int
    reasons: tuple[str, ...]


def calculate_developer_score(snapshot: RepositorySnapshot, *, now: datetime | None = None) -> DeveloperScore:
    current = now or datetime.now(timezone.utc)
    reasons: list[str] = []
    score = 0.0

    # Activity: 40 points.
    commit_points = min(snapshot.commits_30d / 100, 1.0) * 24
    release_points = min(snapshot.releases / 5, 1.0) * 8
    recent_days = max(0, (current - snapshot.updated_at).days)
    recency_points = max(0.0, 8.0 * (1 - min(recent_days, 90) / 90))
    score += commit_points + release_points + recency_points

    if snapshot.commits_30d >= 30:
        reasons.append("active_commit_history")
    if snapshot.releases > 0:
        reasons.append("has_releases")

    # Community: 30 points.
    score += min(snapshot.contributors / 20, 1.0) * 18
    score += min(snapshot.issues_open / 20, 1.0) * 6
    score += min(snapshot.pull_requests_open / 10, 1.0) * 6
    if snapshot.contributors >= 3:
        reasons.append("multiple_contributors")

    # Longevity: 20 points.
    age_days = max(0, (current - snapshot.created_at).days)
    score += min(age_days / 730, 1.0) * 20
    if age_days >= 180:
        reasons.append("established_repository_history")

    # Risk penalties: up to 30 points. We intentionally allow penalties to exceed
    # the nominal 10-point bucket because archive/dead signals should dominate.
    if snapshot.archived:
        score -= 30
        reasons.append("archived_repository")
    if snapshot.contributors <= 1:
        score -= 8
        reasons.append("single_contributor")
    if snapshot.commits_30d == 0 and recent_days >= 60:
        score -= 12
        reasons.append("stale_repository")

    return DeveloperScore(score=max(0, min(100, round(score))), reasons=tuple(reasons))
