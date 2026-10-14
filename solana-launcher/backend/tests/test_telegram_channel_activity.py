"""Aggregated activity analytics over already-stored Telegram messages."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from app.models.social_intelligence import TelegramChannel, TelegramMessage
from app.services.telegram_collector.activity import summarize_channel_activity


@pytest.mark.asyncio
async def test_channel_activity_aggregates_without_exposing_sender_ids(test_app):
    now = datetime(2026, 10, 14, 12, tzinfo=UTC)
    async with test_app.state.sessionmaker() as session:
        channel = TelegramChannel(telegram_id=1337420, username="publicchannel", title="Public")
        session.add(channel)
        await session.flush()
        session.add_all(
            [
                TelegramMessage(
                    channel_id=channel.id, telegram_message_id=1,
                    published_at=now - timedelta(hours=25), text="one",
                    sender_telegram_id=123, reactions=4, replies=2, forwards=1,
                ),
                TelegramMessage(
                    channel_id=channel.id, telegram_message_id=2,
                    published_at=now - timedelta(hours=1), text="two",
                    sender_telegram_id=123, reactions=3, replies=0, forwards=1,
                ),
                TelegramMessage(
                    channel_id=channel.id, telegram_message_id=3,
                    published_at=now - timedelta(hours=2), text="three",
                    sender_telegram_id=456, reactions=1, replies=0, forwards=0,
                ),
                TelegramMessage(
                    channel_id=channel.id, telegram_message_id=4,
                    published_at=now - timedelta(days=45), text="old",
                    sender_telegram_id=789, reactions=100, replies=50, forwards=20,
                ),
            ]
        )
        await session.commit()
        result = await summarize_channel_activity(
            session, channel_id=channel.id, days=30, now=now
        )

    assert result["messages"] == 3
    assert result["unique_senders"] == 2
    assert result["engagements"] == 12
    assert [day["messages"] for day in result["daily"]] == [1, 2]
    assert result["coverage"] == "only_collected_messages"
    assert "sender_telegram_id" not in str(result)
    assert "123" not in str(result)
    assert "456" not in str(result)


@pytest.mark.asyncio
async def test_activity_missing_channel_and_invalid_window(test_app):
    async with test_app.state.sessionmaker() as session:
        with pytest.raises(LookupError):
            await summarize_channel_activity(session, channel_id=987654)
        with pytest.raises(ValueError):
            await summarize_channel_activity(session, channel_id=987654, days=999)
