"""GitHub intelligence provider implementation."""

from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Any

from intelligence.core.models import IntelligenceDocument, ProviderHealth
from intelligence.errors.exceptions import NormalizationError, ProviderError
from intelligence.providers.base import IntelligenceProvider
from intelligence.providers.github.client import GitHubClient
from intelligence.providers.github.models import RepositorySnapshot
from intelligence.providers.github.normalizer import snapshot_to_document


class GitHubIntelligenceProvider(IntelligenceProvider):
    name = "github"

    def __init__(self, client: GitHubClient | None = None) -> None:
        self.client = client or GitHubClient()

    async def collect(self, query: str) -> list[IntelligenceDocument]:
        repository = await self.client.get_repository(query)
        contributors, commits, pull_requests, releases = await asyncio.gather(
            self.client.get_contributor_count(query),
            self.client.get_recent_commit_count(query),
            self.client.get_open_pull_request_count(query),
            self.client.get_release_count(query),
        )
        snapshot = self._build_snapshot(
            repository,
            contributors=contributors,
            commits=commits,
            pull_requests=pull_requests,
            releases=releases,
        )
        return [snapshot_to_document(snapshot)]

    async def health(self) -> ProviderHealth:
        try:
            latency_ms = await self.client.health()
            return ProviderHealth(
                provider=self.name,
                healthy=True,
                latency_ms=latency_ms,
                details={
                    "rate_limit_remaining": self.client.rate_limit.remaining,
                    "rate_limit_reset_epoch": self.client.rate_limit.reset_epoch,
                },
            )
        except ProviderError as exc:
            return ProviderHealth(
                provider=self.name,
                healthy=False,
                details={"error": str(exc)},
            )

    def normalize(self, document: IntelligenceDocument) -> IntelligenceDocument:
        if document.source != "github":
            raise NormalizationError("GitHub provider can only normalize github documents")
        return document

    @staticmethod
    def _build_snapshot(
        repository: dict[str, Any],
        *,
        contributors: int,
        commits: int,
        pull_requests: int,
        releases: int,
    ) -> RepositorySnapshot:
        try:
            open_issues_and_prs = int(repository.get("open_issues_count", 0))
            issues_only = max(0, open_issues_and_prs - pull_requests)
            return RepositorySnapshot(
                name=str(repository["name"]),
                full_name=str(repository["full_name"]),
                url=str(repository["html_url"]),
                stars=int(repository.get("stargazers_count", 0)),
                forks=int(repository.get("forks_count", 0)),
                watchers=int(repository.get("subscribers_count", repository.get("watchers_count", 0))),
                contributors=contributors,
                commits_30d=commits,
                issues_open=issues_only,
                pull_requests_open=pull_requests,
                releases=releases,
                archived=bool(repository.get("archived", False)),
                created_at=_parse_github_datetime(repository["created_at"]),
                updated_at=_parse_github_datetime(repository["updated_at"]),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise NormalizationError("GitHub repository payload is incomplete or invalid") from exc


def _parse_github_datetime(value: Any) -> datetime:
    if not isinstance(value, str):
        raise ValueError("GitHub datetime must be a string")
    return datetime.fromisoformat(value.replace("Z", "+00:00"))
