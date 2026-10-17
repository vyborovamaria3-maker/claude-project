"""Aggregated Telegram channel activity; no individual member records are returned."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.social_intelligence import TelegramChannel, TelegramMessage


async def summarize_channel_activity(
    session: AsyncSession,
    *,
    channel_id: int,
    days: int = 30,
    now: datetime | None = None,
) -> dict:
    """Compute bounded engagement statistics over existing stored messages."""
    if not 1 <= days <= 90:
        raise ValueError("days must be between 1 and 90")
    channel = await session.get(TelegramChannel, channel_id)
    if channel is None:
        raise LookupError("Telegram channel not found")

    cutoff = (now or datetime.now(UTC)) - timedelta(days=days)
    day = func.date(TelegramMessage.published_at)
    result = await session.execute(
        select(
            day.label("day"),
            func.count(TelegramMessage.id).label("messages"),
            func.count(func.distinct(TelegramMessage.sender_telegram_id)).label("senders"),
            func.coalesce(func.sum(TelegramMessage.reactions), 0).label("reactions"),
            func.coalesce(func.sum(TelegramMessage.replies), 0).label("replies"),
            func.coalesce(func.sum(TelegramMessage.forwards), 0).label("forwards"),
        )
        .where(
            TelegramMessage.channel_id == channel_id,
            TelegramMessage.published_at >= cutoff,
        )
        .group_by(day)
        .order_by(day)
    )
    daily = []
    for row in result:
        label = row.day.isoformat() if hasattr(row.day, "isoformat") else str(row.day)
        reactions = int(row.reactions)
        replies = int(row.replies)
        forwards = int(row.forwards)
        daily.append(
            {
                "date": label,
                "messages": int(row.messages),
                "active_senders": int(row.senders),
                "reactions": reactions,
                "replies": replies,
                "forwards": forwards,
                "engagements": reactions + replies + forwards,
            }
        )
    unique_senders = (
        await session.execute(
            select(func.count(func.distinct(TelegramMessage.sender_telegram_id))).where(
                TelegramMessage.channel_id == channel_id,
                TelegramMessage.published_at >= cutoff,
            )
        )
    ).scalar_one()
    return {
        "channel_id": channel_id,
        "channel": channel.username or channel.title,
        "days": days,
        "messages": sum(row["messages"] for row in daily),
        "unique_senders": int(unique_senders),
        "engagements": sum(row["engagements"] for row in daily),
        "daily": daily,
        "source": "stored_messages",
        "coverage": "only_collected_messages",
    }
