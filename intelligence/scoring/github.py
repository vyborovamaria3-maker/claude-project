"""Derived scoring for persisted GitHub intelligence evidence."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from intelligence.core.models import IntelligenceDocument
from intelligence.errors.exceptions import ScoringError
from intelligence.providers.github.models import RepositorySnapshot
from intelligence.providers.github.scoring import DeveloperScore, calculate_developer_score


_REQUIRED_COUNTERS = (
    "stars",
    "forks",
    "watchers",
    "contributors",
    "commits_30d",
    "issues_open",
    "pull_requests_open",
    "releases",
)


def _counter(metrics: dict[str, Any], key: str) -> int:
    value = metrics.get(key)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ScoringError(f"GitHub metric {key} is invalid")
    return value


def _timestamp(metrics: dict[str, Any], key: str) -> datetime:
    value = metrics.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ScoringError(f"GitHub metric {key} is invalid")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ScoringError(f"GitHub metric {key} is invalid") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ScoringError(f"GitHub metric {key} must include timezone")
    return parsed


def snapshot_from_github_document(document: IntelligenceDocument) -> RepositorySnapshot:
    """Reconstruct the provider snapshot needed for deterministic derived scoring."""
    if document.source != "github":
        raise ScoringError("developer scoring requires a GitHub intelligence document")
    if not isinstance(document.metrics, dict):
        raise ScoringError("GitHub intelligence metrics are invalid")

    repository = next(
        (
            entity
            for entity in document.entities
            if isinstance(entity, str) and "/" in entity and entity != "repository"
        ),
        None,
    )
    if repository is None:
        raise ScoringError("GitHub repository entity is missing")
    archived = document.metrics.get("archived")
    if not isinstance(archived, bool):
        raise ScoringError("GitHub metric archived is invalid")
    if not isinstance(document.url, str) or not document.url:
        raise ScoringError("GitHub repository URL is missing")

    counters = {key: _counter(document.metrics, key) for key in _REQUIRED_COUNTERS}
    return RepositorySnapshot(
        name=repository.split("/", 1)[1],
        full_name=repository,
        url=document.url,
        stars=counters["stars"],
        forks=counters["forks"],
        watchers=counters["watchers"],
        contributors=counters["contributors"],
        commits_30d=counters["commits_30d"],
        issues_open=counters["issues_open"],
        pull_requests_open=counters["pull_requests_open"],
        releases=counters["releases"],
        archived=archived,
        created_at=_timestamp(document.metrics, "created_at"),
        updated_at=_timestamp(document.metrics, "updated_at"),
    )


def score_github_document(
    document: IntelligenceDocument,
    *,
    as_of: datetime,
) -> DeveloperScore:
    """Score persisted GitHub evidence without mutating raw/normalized storage."""
    try:
        snapshot = snapshot_from_github_document(document)
        return calculate_developer_score(snapshot, now=as_of)
    except ScoringError:
        raise
    except ValueError as exc:
        raise ScoringError("GitHub intelligence document cannot be scored") from exc
