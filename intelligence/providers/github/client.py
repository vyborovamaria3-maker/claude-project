"""Minimal GitHub REST client for public repository intelligence."""

from __future__ import annotations

import asyncio
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from intelligence.errors.exceptions import ProviderError


@dataclass(frozen=True, slots=True)
class GitHubRateLimit:
    remaining: int | None = None
    reset_epoch: int | None = None


class GitHubClient:
    api_base = "https://api.github.com"

    def __init__(self, *, token: str | None = None, timeout_seconds: float = 15.0) -> None:
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be > 0")
        self._token = token if token is not None else os.getenv("GITHUB_TOKEN")
        self.timeout_seconds = timeout_seconds
        self.rate_limit = GitHubRateLimit()

    async def get_repository(self, full_name: str) -> dict[str, Any]:
        owner, repo = self._validate_full_name(full_name)
        return await self._get_json(f"/repos/{owner}/{repo}")

    async def get_contributor_count(self, full_name: str, *, max_items: int = 100) -> int:
        owner, repo = self._validate_full_name(full_name)
        items = await self._get_json(f"/repos/{owner}/{repo}/contributors?per_page={min(max_items, 100)}")
        return len(items) if isinstance(items, list) else 0

    async def get_recent_commit_count(self, full_name: str, *, days: int = 30, max_items: int = 100) -> int:
        if days <= 0:
            raise ValueError("days must be > 0")
        owner, repo = self._validate_full_name(full_name)
        since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat().replace("+00:00", "Z")
        query = urllib.parse.urlencode({"since": since, "per_page": min(max_items, 100)})
        items = await self._get_json(f"/repos/{owner}/{repo}/commits?{query}")
        return len(items) if isinstance(items, list) else 0

    async def get_open_pull_request_count(self, full_name: str, *, max_items: int = 100) -> int:
        owner, repo = self._validate_full_name(full_name)
        items = await self._get_json(f"/repos/{owner}/{repo}/pulls?state=open&per_page={min(max_items, 100)}")
        return len(items) if isinstance(items, list) else 0

    async def get_release_count(self, full_name: str, *, max_items: int = 100) -> int:
        owner, repo = self._validate_full_name(full_name)
        items = await self._get_json(f"/repos/{owner}/{repo}/releases?per_page={min(max_items, 100)}")
        return len(items) if isinstance(items, list) else 0

    async def health(self) -> int:
        started = asyncio.get_running_loop().time()
        await self._get_json("/rate_limit")
        elapsed = asyncio.get_running_loop().time() - started
        return max(0, round(elapsed * 1000))

    async def _get_json(self, path: str) -> Any:
        return await asyncio.wait_for(
            asyncio.to_thread(self._get_json_sync, path),
            timeout=self.timeout_seconds + 1,
        )

    def _get_json_sync(self, path: str) -> Any:
        headers = {
            "Accept": "application/vnd.github+json",
            "User-Agent": "potapoff-intelligence/1.0",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"

        request = urllib.request.Request(f"{self.api_base}{path}", headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                self.rate_limit = GitHubRateLimit(
                    remaining=self._parse_int(response.headers.get("X-RateLimit-Remaining")),
                    reset_epoch=self._parse_int(response.headers.get("X-RateLimit-Reset")),
                )
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                raise ProviderError("GitHub repository or resource was not found") from exc
            if exc.code in {403, 429}:
                raise ProviderError("GitHub rate limit or access restriction reached") from exc
            raise ProviderError(f"GitHub request failed with HTTP {exc.code}") from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            raise ProviderError("GitHub request failed due to network or timeout error") from exc
        except json.JSONDecodeError as exc:
            raise ProviderError("GitHub returned invalid JSON") from exc

    @staticmethod
    def _validate_full_name(full_name: str) -> tuple[str, str]:
        parts = full_name.strip().split("/")
        if len(parts) != 2 or not all(parts):
            raise ValueError("GitHub repository must use owner/repository format")
        owner, repo = parts
        allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.")
        if any(char not in allowed for char in owner + repo):
            raise ValueError("GitHub repository contains unsupported characters")
        return owner, repo

    @staticmethod
    def _parse_int(value: str | None) -> int | None:
        try:
            return int(value) if value is not None else None
        except ValueError:
            return None
