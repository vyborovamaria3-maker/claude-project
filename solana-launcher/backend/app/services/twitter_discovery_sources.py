from __future__ import annotations

import csv
import json
import re
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx

from app.services.twitter_account_registry import normalize_twitter_username
from app.services.twitter_discovery import ResolvedTwitterProfile


_X_PROFILE_RE = re.compile(
    r"https?://(?:www\.)?(?:x\.com|twitter\.com)/([A-Za-z0-9_]{1,15})(?:[/?#\"'<>\s]|$)",
    re.IGNORECASE,
)
_X_RESERVED = {
    "about",
    "compose",
    "explore",
    "hashtag",
    "home",
    "i",
    "intent",
    "login",
    "messages",
    "notifications",
    "privacy",
    "search",
    "settings",
    "share",
    "signup",
    "tos",
}

_USER_FIELDS = (
    "id,name,username,description,profile_image_url,public_metrics,"
    "verified,created_at,url,location"
)


class DiscoveryRateLimited(RuntimeError):
    def __init__(self, retry_after_seconds: int) -> None:
        self.retry_after_seconds = max(1, int(retry_after_seconds))
        super().__init__(f"X API rate limited; retry after {self.retry_after_seconds}s")


@dataclass(slots=True)
class SeedRecord:
    username: str | None = None
    twitter_id: str | None = None
    account_type: str = "unknown"
    priority: int = 70
    relevance_hint: float = 60.0
    reason: str = "curated_seed"
    source_url: str | None = None


def _safe_username(value: Any) -> str | None:
    try:
        return normalize_twitter_username(None if value is None else str(value))
    except ValueError:
        return None


def _safe_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _safe_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def extract_x_handles(text: str) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for match in _X_PROFILE_RE.finditer(text or ""):
        username = _safe_username(match.group(1))
        if not username or username in _X_RESERVED or username in seen:
            continue
        seen.add(username)
        result.append(username)
    return result


def load_seed_records(path: str | Path) -> list[SeedRecord]:
    seed_path = Path(path)
    if not seed_path.exists():
        return []
    if seed_path.suffix.lower() == ".csv":
        with seed_path.open("r", encoding="utf-8-sig", newline="") as handle:
            rows = list(csv.DictReader(handle))
    else:
        payload = json.loads(seed_path.read_text(encoding="utf-8-sig"))
        rows = payload.get("accounts", []) if isinstance(payload, dict) else payload

    if not isinstance(rows, list):
        return []

    records: list[SeedRecord] = []
    for row in rows:
        if isinstance(row, str):
            username = _safe_username(row)
            if username:
                records.append(SeedRecord(username=username))
            continue
        if not isinstance(row, dict):
            continue
        username = _safe_username(row.get("username"))
        twitter_id = str(row.get("twitter_id") or "").strip()[:32] or None
        if not username and not twitter_id:
            continue
        records.append(
            SeedRecord(
                username=username,
                twitter_id=twitter_id,
                account_type=str(row.get("account_type") or "unknown")[:32],
                priority=max(0, min(100, _safe_int(row.get("priority"), 70))),
                relevance_hint=max(
                    0.0,
                    min(100.0, _safe_float(row.get("relevance_hint"), 60.0)),
                ),
                reason=str(row.get("reason") or "curated_seed")[:96],
                source_url=str(row.get("source_url") or "").strip()[:1024] or None,
            )
        )
    return records


def load_queries(path: str | Path) -> list[str]:
    query_path = Path(path)
    if not query_path.exists():
        return []
    payload = json.loads(query_path.read_text(encoding="utf-8-sig"))
    values = payload.get("queries", []) if isinstance(payload, dict) else payload
    if not isinstance(values, list):
        return []
    return [str(value).strip()[:512] for value in values if str(value).strip()]


def _parse_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _profile_from_x_user(user: dict[str, Any], *, source: str) -> ResolvedTwitterProfile:
    metrics = user.get("public_metrics") if isinstance(user.get("public_metrics"), dict) else {}
    return ResolvedTwitterProfile(
        twitter_id=str(user.get("id") or "").strip(),
        username=_safe_username(user.get("username")),
        display_name=str(user.get("name") or "").strip()[:255] or None,
        bio=str(user.get("description") or ""),
        avatar_url=str(user.get("profile_image_url") or "").strip()[:1024] or None,
        followers_count=max(0, _safe_int(metrics.get("followers_count"), 0)),
        following_count=max(0, _safe_int(metrics.get("following_count"), 0)),
        tweet_count=max(0, _safe_int(metrics.get("tweet_count"), 0)),
        verified=bool(user.get("verified")),
        x_created_at=_parse_datetime(user.get("created_at")),
        source=source,
        raw=user,
    )


class XApiDiscoverySource:
    def __init__(
        self,
        *,
        bearer_token: str,
        client: httpx.AsyncClient,
        base_url: str = "https://api.x.com/2",
    ) -> None:
        token = bearer_token.strip()
        if not token:
            raise ValueError("X API bearer token is required")
        self._client = client
        self._base_url = base_url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {token}"}

    async def _get(self, path: str, *, params: dict[str, Any] | None = None) -> dict[str, Any]:
        response = await self._client.get(
            f"{self._base_url}{path}",
            params=params,
            headers=self._headers,
        )
        if response.status_code == 429:
            retry_after = response.headers.get("retry-after")
            if retry_after and retry_after.isdigit():
                raise DiscoveryRateLimited(int(retry_after))
            reset = response.headers.get("x-rate-limit-reset")
            if reset and reset.isdigit():
                delay = max(1, int(reset) - int(time.time()))
                raise DiscoveryRateLimited(delay)
            raise DiscoveryRateLimited(60)
        response.raise_for_status()
        payload = response.json()
        return payload if isinstance(payload, dict) else {}

    async def resolve_profile(
        self,
        *,
        twitter_id: str | None = None,
        username: str | None = None,
    ) -> ResolvedTwitterProfile | None:
        params = {"user.fields": _USER_FIELDS}
        if twitter_id:
            payload = await self._get(f"/users/{twitter_id}", params=params)
        else:
            normalized = _safe_username(username)
            if not normalized:
                return None
            payload = await self._get(f"/users/by/username/{normalized}", params=params)
        user = payload.get("data")
        if not isinstance(user, dict) or not user.get("id"):
            return None
        return _profile_from_x_user(user, source="x_api_profile")

    async def search_accounts(
        self,
        query: str,
        *,
        max_results: int = 50,
    ) -> list[ResolvedTwitterProfile]:
        limit = max(10, min(int(max_results), 100))
        payload = await self._get(
            "/tweets/search/recent",
            params={
                "query": query,
                "max_results": limit,
                "expansions": "author_id,entities.mentions.username",
                "user.fields": _USER_FIELDS,
                "tweet.fields": "author_id,created_at,entities,public_metrics",
            },
        )
        includes = payload.get("includes")
        users = includes.get("users", []) if isinstance(includes, dict) else []
        result: list[ResolvedTwitterProfile] = []
        seen: set[str] = set()
        for user in users:
            if not isinstance(user, dict) or not user.get("id"):
                continue
            twitter_id = str(user["id"])
            if twitter_id in seen:
                continue
            seen.add(twitter_id)
            result.append(_profile_from_x_user(user, source="x_api_search"))
        return result

    async def network_accounts(
        self,
        twitter_id: str,
        *,
        direction: str,
        max_results: int = 100,
    ) -> list[ResolvedTwitterProfile]:
        normalized_direction = direction.strip().lower()
        if normalized_direction not in {"followers", "following"}:
            raise ValueError("direction must be followers or following")

        remaining = max(1, min(int(max_results), 5000))
        token: str | None = None
        result: list[ResolvedTwitterProfile] = []
        seen: set[str] = set()
        while remaining > 0:
            params: dict[str, Any] = {
                "max_results": min(1000, remaining),
                "user.fields": _USER_FIELDS,
            }
            if token:
                params["pagination_token"] = token
            payload = await self._get(
                f"/users/{twitter_id}/{normalized_direction}",
                params=params,
            )
            rows = payload.get("data") if isinstance(payload.get("data"), list) else []
            for user in rows:
                if not isinstance(user, dict) or not user.get("id"):
                    continue
                user_id = str(user["id"])
                if user_id in seen:
                    continue
                seen.add(user_id)
                result.append(
                    _profile_from_x_user(
                        user,
                        source=f"x_api_{normalized_direction}",
                    )
                )
                remaining -= 1
                if remaining <= 0:
                    break
            meta = payload.get("meta") if isinstance(payload.get("meta"), dict) else {}
            token_value = meta.get("next_token")
            token = str(token_value) if token_value else None
            if not token or not rows:
                break
        return result


class PublicWebDiscoverySource:
    def __init__(self, *, client: httpx.AsyncClient) -> None:
        self._client = client

    async def discover_handles(self, url: str) -> list[str]:
        response = await self._client.get(
            url,
            headers={
                "User-Agent": (
                    "POTAPoff-ResearchBot/1.0 "
                    "(+public profile-link discovery; respects site access controls)"
                )
            },
            follow_redirects=True,
        )
        response.raise_for_status()
        content_type = response.headers.get("content-type", "")
        if not any(kind in content_type for kind in ("text", "xml", "json", "html")):
            return []
        return extract_x_handles(response.text)