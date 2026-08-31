from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta, timezone
import hashlib
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.social_intelligence import TelegramChannel
from app.services.telegram_parser import normalize_telegram_target


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _parse_time(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return _aware(value)
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return _aware(parsed)


def _public_channel_id(username: str) -> int:
    digest = hashlib.sha256(f"telegram-public:{username.lower()}".encode("utf-8")).digest()
    value = int.from_bytes(digest[:8], "big") & ((1 << 63) - 1)
    return -(value or 1)


def _next_delay(
    *,
    state: str,
    relevance_score: float,
    failure_count: int,
    strong_seconds: int,
    normal_seconds: int,
    rejected_seconds: int,
    unavailable_seconds: int,
) -> int:
    if state == "validated":
        return strong_seconds if relevance_score >= 65.0 else normal_seconds
    if state == "rejected":
        return rejected_seconds
    if state == "unavailable":
        multiplier = min(16, 2 ** max(0, failure_count - 1))
        return min(7 * 86400, unavailable_seconds * multiplier)
    return normal_seconds


async def _upsert_registry_channel(session: AsyncSession, username: str) -> TelegramChannel:
    row = (
        await session.execute(
            select(TelegramChannel)
            .where(func.lower(TelegramChannel.username) == username.lower())
            .limit(1)
        )
    ).scalar_one_or_none()
    now = _utcnow()
    if row is None:
        row = TelegramChannel(
            telegram_id=_public_channel_id(username),
            username=username,
            title=username,
            entity_type="channel",
            participants=0,
            about="",
            is_active=True,
            first_seen_at=now,
            last_seen_at=now,
            last_scanned_at=None,
            meta={"collector": "public_web", "public_web": True},
        )
        session.add(row)
        await session.flush()
    return row


async def record_discovery_results(
    sessionmaker: async_sessionmaker[AsyncSession],
    results: list[dict[str, Any]],
    *,
    manual_channels: set[str] | None = None,
    database_channels: set[str] | None = None,
    strong_seconds: int = 600,
    normal_seconds: int = 1800,
    rejected_seconds: int = 21600,
    unavailable_seconds: int = 3600,
) -> None:
    manual = {normalize_telegram_target(value) for value in (manual_channels or set())}
    database = {normalize_telegram_target(value) for value in (database_channels or set())}
    now = _utcnow()
    async with sessionmaker() as session:
        for result in results:
            username = normalize_telegram_target(str(result.get("username") or ""))
            if not username:
                continue
            channel = await _upsert_registry_channel(session, username)
            old_meta = dict(channel.meta or {})
            old_registry = old_meta.get("discovery_registry")
            old_registry = dict(old_registry) if isinstance(old_registry, dict) else {}
            old_failures = int(old_registry.get("failure_count") or 0)

            if result.get("error"):
                state = "unavailable"
                failure_count = old_failures + 1
            elif result.get("filtered"):
                state = "rejected"
                failure_count = 0
            else:
                state = "validated"
                failure_count = 0

            relevance = result.get("memecoin_relevance")
            relevance = relevance if isinstance(relevance, dict) else {}
            relevance_score = float(relevance.get("score") or 0.0)
            source = "graph"
            if username in manual:
                source = "manual"
            elif username in database:
                source = "tgdataset"
            elif not result.get("discovered_from"):
                source = str(old_registry.get("source") or "registry")

            delay = _next_delay(
                state=state,
                relevance_score=relevance_score,
                failure_count=failure_count,
                strong_seconds=max(60, strong_seconds),
                normal_seconds=max(60, normal_seconds),
                rejected_seconds=max(300, rejected_seconds),
                unavailable_seconds=max(300, unavailable_seconds),
            )
            registry = {
                "state": state,
                "source": source,
                "discovered_from": result.get("discovered_from"),
                "depth": int(result.get("discovery_depth") or 0),
                "relevance_score": relevance_score,
                "failure_count": failure_count,
                "last_checked_at": now.isoformat(),
                "next_check_at": (now + timedelta(seconds=delay)).isoformat(),
                "last_error": str(result.get("error") or "")[:500] or None,
            }
            channel.meta = {
                **old_meta,
                "public_web": True,
                "discovery_registry": registry,
                **({"memecoin_relevance": relevance} if relevance else {}),
            }
            channel.last_seen_at = now
            if state == "validated":
                channel.is_active = True
                channel.last_scanned_at = now
            elif state == "unavailable" and failure_count >= 8:
                channel.is_active = False
        await session.commit()


async def due_registry_channels(
    sessionmaker: async_sessionmaker[AsyncSession],
    *,
    limit: int = 25,
) -> list[str]:
    now = _utcnow()
    safe_limit = max(1, min(int(limit), 200))
    async with sessionmaker() as session:
        rows = list(
            (
                await session.execute(
                    select(TelegramChannel)
                    .where(TelegramChannel.username.is_not(None))
                    .order_by(TelegramChannel.last_seen_at.desc())
                    .limit(5000)
                )
            ).scalars().all()
        )
    due: list[tuple[datetime, str]] = []
    for channel in rows:
        meta = channel.meta or {}
        registry = meta.get("discovery_registry") if isinstance(meta, dict) else None
        if not isinstance(registry, dict):
            continue
        username = normalize_telegram_target(channel.username or "")
        if not username:
            continue
        next_check = _parse_time(registry.get("next_check_at")) or now
        if next_check <= now:
            due.append((next_check, username))
    due.sort(key=lambda item: item[0])
    return [username for _, username in due[:safe_limit]]


async def registry_summary(
    sessionmaker: async_sessionmaker[AsyncSession],
) -> dict[str, Any]:
    now = _utcnow()
    async with sessionmaker() as session:
        rows = list(
            (
                await session.execute(
                    select(TelegramChannel).where(TelegramChannel.username.is_not(None)).limit(5000)
                )
            ).scalars().all()
        )
    states: Counter[str] = Counter()
    due = 0
    for channel in rows:
        meta = channel.meta or {}
        registry = meta.get("discovery_registry") if isinstance(meta, dict) else None
        if not isinstance(registry, dict):
            continue
        state = str(registry.get("state") or "candidate")
        states[state] += 1
        next_check = _parse_time(registry.get("next_check_at"))
        if next_check is None or next_check <= now:
            due += 1
    return {
        "total": sum(states.values()),
        "validated": states.get("validated", 0),
        "rejected": states.get("rejected", 0),
        "unavailable": states.get("unavailable", 0),
        "candidate": states.get("candidate", 0),
        "due": due,
    }
