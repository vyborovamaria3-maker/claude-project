"""Idempotent, privacy-minimizing tgparser-cli archive import."""

from __future__ import annotations

from datetime import UTC

import pytest
from app.models.social_intelligence import TelegramChannel, TelegramMessage
from app.services.telegram_collector.tgparser_import import import_tgparser_archive
from sqlalchemy import func, select


@pytest.mark.asyncio
async def test_tgparser_archive_import_is_idempotent_and_omits_author(test_app):
    async with test_app.state.sessionmaker() as session:
        channel = TelegramChannel(telegram_id=987654, username="publictest", title="Public Test")
        session.add(channel)
        await session.commit()
        records = [
            {
                "id": 7,
                "channel": "@publictest",
                "date": "2026-10-14T10:00:00+00:00",
                "author": "private-person",
                "media_urls": ["https://example.invalid/private"],
                "text": "Hello",
                "reactions": {"👍": 3, "🔥": 2},
                "raw_source": "mtproto",
            },
            {
                "id": "8",
                "channel": "@publictest",
                "date": "2026-10-14T11:00:00",
                "author": "other-person",
                "text": "Привет",
                "reactions": '{"👍": 4}',
                "raw_source": "web",
            },
        ]
        first = await import_tgparser_archive(session, channel_id=channel.id, records=records)
        await session.commit()
        second = await import_tgparser_archive(session, channel_id=channel.id, records=records)
        await session.commit()
        stored = (
            await session.execute(
                select(TelegramMessage).where(TelegramMessage.channel_id == channel.id)
                .order_by(TelegramMessage.telegram_message_id)
            )
        ).scalars().all()
    assert first["inserted"] == 2
    assert second["duplicates"] == 2
    assert len(stored) == 2
    assert stored[0].reactions == 5
    assert stored[1].reactions == 4
    assert stored[1].published_at.replace(tzinfo=UTC).tzinfo == UTC
    assert stored[1].raw["assumed_utc"] is True
    assert all(x.sender_telegram_id is None and x.sender_name is None for x in stored)
    assert "private-person" not in str([x.raw for x in stored])


@pytest.mark.asyncio
async def test_tgparser_archive_rejects_source_mixups_and_bad_dates(test_app):
    async with test_app.state.sessionmaker() as session:
        channel = TelegramChannel(telegram_id=987655, username="publicother", title="Other")
        session.add(channel)
        await session.commit()
        base = {
            "id": 1, "channel": "publicother", "text": "Hello",
            "date": "2026-10-14T10:00:00Z",
        }
        for bad in (
            {**base, "channel": "differentchannel"},
            {**base, "date": "not-a-date"},
            {**base, "reactions": {"❤️": -1}},
            {**base, "id": 0},
        ):
            with pytest.raises(ValueError):
                await import_tgparser_archive(session, channel_id=channel.id, records=[bad])
        assert (
            await session.execute(
                select(func.count(TelegramMessage.id)).where(
                    TelegramMessage.channel_id == channel.id
                )
            )
        ).scalar_one() == 0


def test_tgparser_archive_json_and_csv_match_documented_schema(tmp_path):
    from app.cli.telegram_import_tgparser import read_archive

    json_path = tmp_path / "archive.json"
    json_path.write_text('[{"id":1,"channel":"channel","date":"2026-10-14T00:00:00Z"}]')
    csv_path = tmp_path / "archive.csv"
    csv_path.write_text("id,channel,date\n1,channel,2026-10-14T00:00:00Z\n")
    assert read_archive(json_path)[0]["id"] == 1
    assert read_archive(csv_path)[0]["id"] == "1"
