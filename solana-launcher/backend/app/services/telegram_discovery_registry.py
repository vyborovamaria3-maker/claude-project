from __future__ import annotations

import hashlib
import re
from collections import Counter
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.social_intelligence import TelegramChannel
from app.services.telegram_parser import normalize_telegram_target

_REGISTRY_PAGE_SIZE = 5000
_DATASET_SOURCES = frozenset({"tgdataset", "teragram", "custom"})


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


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
    digest = hashlib.sha256(f"telegram-public:{username.lower()}".encode()).digest()
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


async def _load_registry_channels(
    sessionmaker: async_sessionmaker[AsyncSession],
) -> list[TelegramChannel]:
    """Load the complete registry in bounded DB pages instead of silently truncating at 5000."""

    rows: list[TelegramChannel] = []
    offset = 0
    async with sessionmaker() as session:
        while True:
            page = list(
                (
                    await session.execute(
                        select(TelegramChannel)
                        .where(TelegramChannel.username.is_not(None))
                        .order_by(TelegramChannel.id.asc())
                        .offset(offset)
                        .limit(_REGISTRY_PAGE_SIZE)
                    )
                )
                .scalars()
                .all()
            )
            rows.extend(page)
            if len(page) < _REGISTRY_PAGE_SIZE:
                break
            offset += len(page)
    return rows


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
            new_score = relevance.get("score")
            if new_score is None:
                new_score = old_registry.get("relevance_score")
            try:
                relevance_score = float(new_score) if new_score is not None else 0.0
            except (TypeError, ValueError):
                relevance_score = 0.0
            relevance_score = max(0.0, min(100.0, relevance_score))

            source = "graph"
            if username in manual:
                source = "manual"
            elif username in database:
                source = str(old_registry.get("source") or "tgdataset")
            elif not result.get("discovered_from"):
                source = str(old_registry.get("source") or "registry")

            discovered_from = result.get("discovered_from") or old_registry.get("discovered_from")
            result_depth = result.get("discovery_depth")
            if discovered_from is None:
                depth = int(old_registry.get("depth") or result_depth or 0)
            elif result.get("discovered_from"):
                depth = int(result_depth or 0)
            else:
                depth = int(old_registry.get("depth") or 0)

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
                "discovered_from": discovered_from,
                "depth": depth,
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
            if state != "unavailable":
                channel.last_seen_at = now
            if state == "validated":
                channel.is_active = True
                channel.last_scanned_at = now
            elif state == "unavailable" and failure_count >= 8:
                channel.is_active = False
        await session.commit()


_DATASET_USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{5,32}$")
_DATASET_RESERVED_USERNAMES = {"share", "addstickers", "proxy", "socks", "iv", "login", "joinchat"}


def _flag(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().casefold() in {"1", "true", "yes", "y"}
    return False


def _nonnegative_int(value: Any) -> int | None:
    if isinstance(value, bool) or value is None or value == "":
        return None
    try:
        parsed = int(float(value))
    except (TypeError, ValueError, OverflowError):
        return None
    return max(0, min(parsed, 2_147_483_647))


async def import_dataset_channel_candidates(
    sessionmaker: async_sessionmaker[AsyncSession],
    records: Iterable[dict[str, Any]],
    *,
    source_name: str,
    source_url: str = "",
    source_license: str = "",
    source_attribution: str = "",
    batch_size: int = 250,
) -> dict[str, int]:
    """Idempotently stage public dataset channels in the existing due-scan registry.

    Dataset rows are metadata only. The regular public-web collector validates candidates and
    stores messages; scam-marked records and malformed targets are rejected before queueing.
    """
    safe_batch_size = max(1, min(int(batch_size), 1000))
    now = _utcnow()
    stats = {"received": 0, "accepted": 0, "invalid": 0, "scam_skipped": 0}
    pending = 0

    async with sessionmaker() as session:
        for record in records:
            stats["received"] += 1
            if not isinstance(record, dict):
                stats["invalid"] += 1
                continue
            if _flag(record.get("scam")):
                stats["scam_skipped"] += 1
                continue

            username = normalize_telegram_target(
                str(record.get("username") or record.get("url") or "")
            )
            if (
                not username
                or not _DATASET_USERNAME_RE.fullmatch(username)
                or username in _DATASET_RESERVED_USERNAMES
            ):
                stats["invalid"] += 1
                continue

            channel = await _upsert_registry_channel(session, username)
            old_meta = dict(channel.meta or {})
            title = str(record.get("title") or "").strip()[:255]
            description = str(record.get("about") or record.get("description") or "").strip()[:4000]
            participants = _nonnegative_int(
                record.get("participants", record.get("n_subscribers", record.get("subscribers")))
            )
            if title and (not channel.title or channel.title.casefold() == username.casefold()):
                channel.title = title
            if description and not channel.about:
                channel.about = description
            if participants is not None and participants > channel.participants:
                channel.participants = participants

            source = str(record.get("source_name") or source_name).strip()[:100] or source_name
            source_entry = {
                "url": str(record.get("source_url") or source_url)[:500] or None,
                "license": str(record.get("license") or source_license)[:100] or None,
                "attribution": str(
                    record.get("attribution") or source_attribution or ""
                )[:150] or None,
                "snapshot": str(record.get("snapshot") or "")[:40] or None,
                "topic": str(record.get("topic") or "")[:80] or None,
                "language": str(record.get("language") or "")[:40] or None,
                "verified": (
                    _flag(record.get("verified"))
                    if record.get("verified") is not None
                    else None
                ),
                "subscribers": participants,
                "posts_per_day": (
                    record.get("posts_per_day")
                    if record.get("posts_per_day") not in (None, "")
                    else None
                ),
                "recommended_by": _nonnegative_int(record.get("recommended_by")),
                "dataset_telegram_id": str(
                    record.get("channel_id") or record.get("dataset_telegram_id") or ""
                )[:32] or None,
                "created": str(
                    record.get("creation_date") or record.get("created") or ""
                )[:40] or None,
                "imported_at": now.isoformat(),
            }
            sources = old_meta.get("dataset_sources")
            sources = list(sources) if isinstance(sources, list) else []
            if source not in sources:
                sources.append(source)
            provenance = old_meta.get("dataset_provenance")
            provenance = dict(provenance) if isinstance(provenance, dict) else {}
            previous_entry = provenance.get(source)
            if isinstance(previous_entry, dict):
                merged_entry = dict(previous_entry)
                for key, value in source_entry.items():
                    if key == "imported_at" or value not in (None, ""):
                        merged_entry[key] = value
                source_entry = merged_entry
            provenance[source] = source_entry

            raw_tags = record.get("tags")
            tags = (
                [str(tag).strip().casefold()[:48] for tag in raw_tags if str(tag).strip()]
                if isinstance(raw_tags, list)
                else []
            )
            topic = str(record.get("topic") or "").strip().casefold()
            if topic:
                tags.append(topic)
            previous_tags = old_meta.get("dataset_tags")
            if isinstance(previous_tags, list):
                tags = [
                    str(tag).strip().casefold()[:48]
                    for tag in [*previous_tags, *tags]
                    if str(tag).strip()
                ]
            tags = list(dict.fromkeys(tags))[:30]

            registry = old_meta.get("discovery_registry")
            registry = dict(registry) if isinstance(registry, dict) else {}
            if not registry:
                registry = {
                    "state": "candidate",
                    "source": source,
                    "discovered_from": None,
                    "depth": 0,
                    "relevance_score": 0.0,
                    "failure_count": 0,
                    "last_checked_at": None,
                    "next_check_at": now.isoformat(),
                    "last_error": None,
                }
            else:
                registry.setdefault("source", source)
                registry.setdefault("state", "candidate")
                registry.setdefault("depth", 0)
                registry.setdefault("failure_count", 0)
                registry.setdefault("relevance_score", 0.0)
                registry.setdefault("last_checked_at", None)
                registry.setdefault("next_check_at", now.isoformat())

            channel.meta = {
                **old_meta,
                "public_web": True,
                "dataset_imported": True,
                "dataset_sources": sources[-20:],
                "dataset_provenance": provenance,
                "dataset_tags": tags,
                "dataset_verified": bool(old_meta.get("dataset_verified"))
                or _flag(record.get("verified")),
                "discovery_registry": registry,
            }
            stats["accepted"] += 1
            pending += 1
            if pending >= safe_batch_size:
                await session.commit()
                pending = 0
        if pending:
            await session.commit()
    return stats


async def due_registry_channels(
    sessionmaker: async_sessionmaker[AsyncSession],
    *,
    limit: int = 25,
    sources: set[str] | None = None,
) -> list[str]:
    now = _utcnow()
    safe_limit = max(1, min(int(limit), 200))
    rows = await _load_registry_channels(sessionmaker)
    due: list[tuple[datetime, str]] = []
    for channel in rows:
        meta = channel.meta or {}
        registry = meta.get("discovery_registry") if isinstance(meta, dict) else None
        if not isinstance(registry, dict):
            continue
        if sources is not None:
            registry_source = str(registry.get("source") or "")
            if registry_source not in sources:
                dataset_meta = meta.get("dataset_import") if isinstance(meta, dict) else None
                dataset_sources = (
                    dataset_meta.get("sources")
                    if isinstance(dataset_meta, dict)
                    else None
                )
                has_dataset_provenance = (
                    isinstance(dataset_sources, dict) and bool(dataset_sources)
                )
                is_dataset_queue = bool(sources.intersection(_DATASET_SOURCES))
                # A channel may first be discovered through the graph and later appear in a
                # historical dataset. Include it in the dataset queue, but never steal a
                # manually configured channel from its manual lifecycle.
                if not (
                    is_dataset_queue
                    and has_dataset_provenance
                    and registry_source != "manual"
                ):
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
    rows = await _load_registry_channels(sessionmaker)
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
