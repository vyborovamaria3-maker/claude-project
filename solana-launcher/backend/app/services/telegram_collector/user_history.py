"""Bounded Telegram message reader for authenticated users' own public channels."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon.tl.types import Channel

USERNAME = re.compile(r"^@?[A-Za-z][A-Za-z0-9_]{4,31}$")


def normalize_public_channel(value: str) -> str:
    """Resolve *only* public usernames, never invite hashes or URL join links."""
    target = value.strip()
    if not USERNAME.fullmatch(target):
        raise ValueError("Use a public @channel username (no invitation links)")
    return target.lstrip("@")


def safe_message_record(message: Any) -> dict[str, str | int | None]:
    """Do not include sender IDs, access hashes, phone numbers or raw MTProto entities."""
    published: datetime | None = getattr(message, "date", None)
    return {
        "message_id": int(getattr(message, "id", 0)),
        "text": str(getattr(message, "message", None) or ""),
        "published_at": published.isoformat() if published else None,
        "views": int(getattr(message, "views", 0) or 0),
        "forwards": int(getattr(message, "forwards", 0) or 0),
    }


async def load_public_history(
    *,
    api_id: int,
    api_hash: str,
    session_string: str,
    username: str,
    limit: int,
) -> list[dict[str, str | int | None]]:
    """Use a transient client; do not mutate channel membership or reuse sessions across owners."""
    if not 1 <= limit <= 200:
        raise ValueError("Message limit must be between 1 and 200")
    target = normalize_public_channel(username)
    client = TelegramClient(StringSession(session_string), api_id, api_hash)
    try:
        await client.connect()
        if not await client.is_user_authorized():
            raise PermissionError("Telegram session has expired")
        try:
            entity = await client.get_entity("@" + target)
        except ValueError as exc:
            raise LookupError("Public channel not found or not accessible") from exc

        if not isinstance(entity, Channel) or not getattr(entity, "username", None):
            raise PermissionError("Only public channels and groups are supported")

        rows: list[dict[str, str | int | None]] = []
        async for message in client.iter_messages(entity, limit=limit):
            rows.append(safe_message_record(message))
        return rows
    finally:
        await client.disconnect()
