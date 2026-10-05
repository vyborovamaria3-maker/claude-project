from __future__ import annotations

from collections import Counter
from datetime import UTC, datetime, timedelta
from typing import Any


def _aware(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _parse_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return _aware(value)
    if isinstance(value, str):
        try:
            return _aware(datetime.fromisoformat(value.replace("Z", "+00:00")))
        except ValueError:
            return None
    return None


def normalize_social_source(value: str) -> str:
    normalized = value.strip().lower().lstrip("@")
    for prefix in ("https://t.me/", "http://t.me/", "t.me/"):
        if normalized.startswith(prefix):
            normalized = normalized[len(prefix) :]
            break
    return normalized.strip("/").split("/", 1)[0].split("?", 1)[0].split("#", 1)[0]


def social_event_engagement(item: dict[str, Any]) -> int:
    metrics = item.get("metrics") or {}
    if item.get("platform") == "telegram":
        keys = ("reactions", "forwards", "replies")
    else:
        keys = ("likes", "retweets", "replies")
    total = 0
    for key in keys:
        try:
            total += max(int(metrics.get(key) or 0), 0)
        except (TypeError, ValueError):
            continue
    return total


def is_explicit_telegram_call(item: dict[str, Any]) -> bool:
    if str(item.get("platform") or "").lower() != "telegram":
        return False
    metrics = item.get("metrics") or {}
    if bool(metrics.get("explicit_call") or metrics.get("is_explicit_call")):
        return True
    return "call" in str(item.get("event_type") or "").lower()


def filter_timeline_payload(
    payload: dict[str, Any],
    *,
    platform: str | None = None,
    hours: int | None = None,
    sources: set[str] | None = None,
    explicit_calls_only: bool = False,
    min_engagement: int = 0,
    min_channel_score: float = 0.0,
    channel_scores: dict[str, float] | None = None,
    limit: int = 200,
    now: datetime | None = None,
) -> dict[str, Any]:
    normalized_sources = {
        normalize_social_source(value) for value in (sources or set()) if value.strip()
    }
    scores = {
        normalize_social_source(key): float(value) for key, value in (channel_scores or {}).items()
    }
    cutoff = None
    if hours is not None:
        cutoff = _aware(now or datetime.now(UTC)) - timedelta(hours=max(hours, 1))

    items: list[dict[str, Any]] = []
    for raw in payload.get("timeline") or []:
        item = dict(raw)
        item_platform = str(item.get("platform") or "").lower()
        if platform and item_platform != platform.lower():
            continue

        occurred_at = _parse_datetime(item.get("occurred_at"))
        if cutoff is not None and (occurred_at is None or occurred_at < cutoff):
            continue

        source = normalize_social_source(
            str(item.get("source_handle") or item.get("source_name") or "")
        )
        if normalized_sources and source not in normalized_sources:
            continue

        if explicit_calls_only and item_platform == "telegram":
            if not is_explicit_telegram_call(item):
                continue
        if min_engagement > 0 and social_event_engagement(item) < min_engagement:
            continue
        if (
            min_channel_score > 0
            and item_platform == "telegram"
            and scores.get(source, 0.0) < min_channel_score
        ):
            continue

        items.append(item)

    items.sort(
        key=lambda row: _parse_datetime(row.get("occurred_at")) or datetime.min.replace(tzinfo=UTC)
    )
    matched_before_limit = len(items)
    matched_platforms = Counter(str(item.get("platform") or "unknown").lower() for item in items)
    matched_sources = {
        normalize_social_source(str(item.get("source_handle") or item.get("source_name") or ""))
        for item in items
        if item.get("source_handle") or item.get("source_name")
    }
    explicit_telegram_calls = sum(is_explicit_telegram_call(item) for item in items)
    first_matched_at = items[0].get("occurred_at") if items else None
    last_matched_at = items[-1].get("occurred_at") if items else None

    max_items = max(1, min(int(limit), 1000))
    truncated = matched_before_limit > max_items
    retained = items[-max_items:] if truncated else items

    platforms = Counter(str(item.get("platform") or "unknown").lower() for item in retained)
    ranked = [{**item, "rank": index + 1} for index, item in enumerate(retained)]
    return {
        "mint_address": payload.get("mint_address"),
        "mentions": len(ranked),
        "platforms": dict(platforms),
        "origin": ranked[0] if ranked else None,
        "timeline": ranked,
        "meta": {
            "matchedBeforeLimit": matched_before_limit,
            "returned": len(ranked),
            "truncated": truncated,
            "matchedPlatforms": dict(matched_platforms),
            "uniqueSourcesBeforeLimit": len(matched_sources),
            "explicitTelegramCallsBeforeLimit": explicit_telegram_calls,
            "firstMatchedAt": first_matched_at,
            "lastMatchedAt": last_matched_at,
        },
        "filters": {
            "platform": platform,
            "hours": hours,
            "sources": sorted(normalized_sources),
            "explicit_calls_only": explicit_calls_only,
            "min_engagement": min_engagement,
            "min_channel_score": min_channel_score,
            "limit": max_items,
        },
    }
