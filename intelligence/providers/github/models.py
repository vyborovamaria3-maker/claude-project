"""Normalized GitHub repository snapshot models."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True, slots=True)
class RepositorySnapshot:
    name: str
    full_name: str
    url: str
    stars: int
    forks: int
    watchers: int
    contributors: int
    commits_30d: int
    issues_open: int
    pull_requests_open: int
    releases: int
    archived: bool
    created_at: datetime
    updated_at: datetime

    def __post_init__(self) -> None:
        counters = (
            self.stars,
            self.forks,
            self.watchers,
            self.contributors,
            self.commits_30d,
            self.issues_open,
            self.pull_requests_open,
            self.releases,
        )
        if any(value < 0 for value in counters):
            raise ValueError("repository counters must be non-negative")
