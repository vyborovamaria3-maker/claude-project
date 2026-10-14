"""Read-only archive normalization and idempotent import of tgparser-cli JSON/CSV.

No Telegram API calls or inferred user identities. Archives are untrusted input.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.social_intelligence import TelegramChannel, TelegramMessage

MAX_BATCH = 500
MAX_TEXT = 16_384


def _reaction_total(raw: Any) -> int:
    if not raw:
        return 0
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (ValueError, TypeError) as exc:
            raise ValueError("Invalid archive reaction JSON") from exc
    if not isinstance(raw, dict):
        raise ValueError("Archive reactions must be an object")
    total = 0
    for count in raw.values():
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            raise ValueError("Archive reaction counts must be non-negative integers")
        total += count
    return min(total, 2_147_483_647)


def _normalize_row(row: dict[str, Any], allowed_channels: set[str]) -> dict[str, Any]:
    if not isinstance(row, dict):
        raise ValueError("Each archive entry must be an object")
    raw_id = row.get("id")
    if isinstance(raw_id, bool) or not isinstance(raw_id, (int, str)):
        raise ValueError("Archive message id must be a positive integer")
    if isinstance(raw_id, str) and not raw_id.isdecimal():
        raise ValueError("Archive message id must be a positive integer")
    message_id = int(raw_id)
    if message_id <= 0 or message_id >= 2**63:
        raise ValueError("Archive message id is out of range")

    source = str(row.get("channel") or "").strip().lstrip("@").lower()
    if not source or source not in allowed_channels:
        raise ValueError("Archive channel does not match the selected destination channel")

    raw_date = row.get("date")
    if not isinstance(raw_date, str):
        raise ValueError("Archive message date must be an ISO 8601 string")
    try:
        published = datetime.fromisoformat(raw_date.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("Archive message date is not valid ISO 8601") from exc
    assumed_utc = published.tzinfo is None
    if assumed_utc:
        published = published.replace(tzinfo=UTC)
    else:
        published = published.astimezone(UTC)

    text = row.get("text") or ""
    if not isinstance(text, str) or len(text) > MAX_TEXT:
        raise ValueError("Archive message text is too large or malformed")

    raw_source = str(row.get("raw_source") or "unknown")
    return {
        "telegram_message_id": message_id,
        "published_at": published,
        "text": text,
        "reactions": _reaction_total(row.get("reactions")),
        # Do not persist authors, private media URLs or arbitrary raw archive metadata.
        "raw": {
            "collector": "tgparser_cli_archive",
            "source": raw_source[:32],
            "assumed_utc": assumed_utc,
            "coverage": "archive_only",
        },
    }


async def import_tgparser_archive(
    session: AsyncSession, *, channel_id: int, records: list[dict[str, Any]]
) -> dict[str, int]:
    """Stage at most 500 archive rows; caller controls transaction commit/rollback.

    The Telegram channel must already exist in the intelligence database, so
    imported message records cannot create fabricated Telegram sources.
    """
    if not isinstance(records, list) or not 1 <= len(records) <= MAX_BATCH:
        raise ValueError("Archive import requires 1–500 messages per batch")
    channel = await session.get(TelegramChannel, channel_id)
    if channel is None:
        raise LookupError("Selected Telegram channel does not exist")
    allowed = {
        value.strip().lstrip("@").lower()
        for value in (channel.username, channel.title)
        if value
    }
    normalized: dict[int, dict[str, Any]] = {}
    for record in records:
        parsed = _normalize_row(record, allowed)
        normalized.setdefault(parsed["telegram_message_id"], parsed)

    known_ids = (
        await session.execute(
            select(TelegramMessage.telegram_message_id).where(
                TelegramMessage.channel_id == channel_id,
                TelegramMessage.telegram_message_id.in_(list(normalized)),
            )
        )
    ).scalars().all()
    known = set(known_ids)
    missing = [record for msg_id, record in normalized.items() if msg_id not in known]
    for record in missing:
        session.add(TelegramMessage(channel_id=channel_id, **record))
    await session.flush()
    return {
        "channel_id": channel_id,
        "received": len(records),
        "inserted": len(missing),
        "duplicates": len(records) - len(missing),
    }
