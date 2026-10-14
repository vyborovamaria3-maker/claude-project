"""Database-backed backfill regression: oldest message is a persistent resume cursor."""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from pydantic import ValidationError
from sqlalchemy import func, select

from app.models.social_intelligence import TelegramChannel, TelegramMessage
from app.schemas.social_intelligence import TelegramBackfillRequest
from app.services import telegram_intelligence
from app.services.telegram_intelligence import TelegramIntelligenceService
from app.services.telegram_parser import parse_telegram_message


class FakeChannel:
    def __init__(self) -> None:
        self.id = 444
        self.username = "publicchannel"
        self.title = "Public Test Channel"


class FakeClient:
    def __init__(self) -> None:
        self.available_ids = list(range(1, 13))
        self.calls: list[dict] = []

    async def get_entity(self, username: str) -> FakeChannel:
        assert username == "@publicchannel"
        return FakeChannel()

    def iter_messages(
        self,
        entity: FakeChannel,
        *,
        limit: int,
        min_id: int = 0,
        max_id: int = 0,
        reverse: bool = False,
    ):
        assert isinstance(entity, FakeChannel)
        self.calls.append(
            {"min_id": min_id, "max_id": max_id, "reverse": reverse, "limit": limit}
        )
        ids = [x for x in self.available_ids if (not min_id or x > min_id)]
        if max_id:
            ids = [x for x in ids if x < max_id]
        ids.sort(reverse=not reverse)

        async def generate():
            for message_id in ids[:limit]:
                yield SimpleNamespace(
                    id=message_id, date=datetime(2026, 10, 1, tzinfo=UTC),
                    message=f"Message {message_id}"
                )

        return generate()


@pytest.mark.asyncio
async def test_backfill_resumes_at_oldest_saved_message(test_app, monkeypatch):
    monkeypatch.setattr(telegram_intelligence, "Channel", FakeChannel)
    client = FakeClient()
    service = object.__new__(TelegramIntelligenceService)
    service.client = client
    service.sessionmaker = test_app.state.sessionmaker

    async def upsert_channel(session, entity):
        row = (
            await session.execute(
                select(TelegramChannel).where(TelegramChannel.telegram_id == entity.id)
            )
        ).scalar_one_or_none()
        if row is None:
            row = TelegramChannel(
                telegram_id=entity.id,
                username=entity.username,
                title=entity.title,
                entity_type="channel",
                about="",
                meta={},
            )
            session.add(row)
        await session.flush()
        return row

    async def save_message(session, channel, message, *, update_score=True):
        found = (
            await session.execute(
                select(TelegramMessage).where(
                    TelegramMessage.channel_id == channel.id,
                    TelegramMessage.telegram_message_id == message.id,
                )
            )
        ).scalar_one_or_none()
        if found is None:
            session.add(
                TelegramMessage(
                    channel_id=channel.id,
                    telegram_message_id=message.id,
                    published_at=message.date,
                    text=message.message,
                )
            )
            await session.flush()
        return parse_telegram_message(message.message), 0

    service.upsert_channel = upsert_channel
    service.save_message = save_message

    observed = []
    for _ in range(5):
        result = await service.scan_channel("@publicchannel", post_limit=3, backfill=True)
        observed.append((result["oldest_before"], result["oldest_after"], result["new_messages"]))

    assert observed == [
        (0, 10, 3),
        (10, 7, 3),
        (7, 4, 3),
        (4, 1, 3),
        (1, 1, 0),
    ]
    assert [x["max_id"] for x in client.calls] == [0, 10, 7, 4, 1]
    async with test_app.state.sessionmaker() as session:
        count = (await session.execute(select(func.count(TelegramMessage.id)))).scalar_one()
    assert count == 12


def test_backfill_request_bounds_and_rejects_private_invites():
    assert TelegramBackfillRequest(channel="@publicchannel", post_limit=1000).post_limit == 1000
    with pytest.raises(ValidationError):
        TelegramBackfillRequest(channel="https://t.me/+privateInvite", post_limit=100)
    with pytest.raises(ValidationError):
        TelegramBackfillRequest(channel="@publicchannel", post_limit=1001)
