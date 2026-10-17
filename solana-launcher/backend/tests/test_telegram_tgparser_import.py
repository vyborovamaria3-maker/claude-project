"""Idempotent, privacy-minimizing tgparser-cli archive import."""

from __future__ import annotations

from datetime import UTC

import pytest
from app.cli import telegram_import_tgparser
from app.models.social_intelligence import TelegramChannel, TelegramMessage
from app.services.telegram_collector.tgparser_import import import_tgparser_archive
from app.services.telegram_intelligence import is_first_trusted_observation
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
    assert is_first_trusted_observation(stored[0]) is True
    stored[0].raw = {"collector": "mtproto"}
    assert is_first_trusted_observation(stored[0]) is False
    assert is_first_trusted_observation(None) is True


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


@pytest.mark.asyncio
async def test_tgparser_archive_rejects_mutable_title_and_conflicting_duplicate_ids(test_app):
    async with test_app.state.sessionmaker() as session:
        channel = TelegramChannel(
            telegram_id=987656, username="realchannel", title="Untrusted Mutable Title"
        )
        session.add(channel)
        await session.commit()
        base = {
            "id": 7,
            "channel": "realchannel",
            "date": "2026-10-14T10:00:00Z",
            "text": "original",
        }
        with pytest.raises(ValueError, match="username"):
            await import_tgparser_archive(
                session, channel_id=channel.id,
                records=[{**base, "channel": "Untrusted Mutable Title"}],
            )
        with pytest.raises(ValueError, match="Conflicting entries"):
            await import_tgparser_archive(
                session, channel_id=channel.id,
                records=[base, {**base, "text": "changed"}],
            )
        with pytest.raises(ValueError, match="channel ID"):
            await import_tgparser_archive(
                session, channel_id=channel.id,
                records=[{**base, "telegram_channel_id": 123456}],
            )
        assert (await session.execute(
            select(func.count(TelegramMessage.id)).where(
                TelegramMessage.channel_id == channel.id
            )
        )).scalar_one() == 0


@pytest.mark.asyncio
async def test_tgparser_archive_supports_stable_numeric_channel_id(test_app):
    async with test_app.state.sessionmaker() as session:
        channel = TelegramChannel(telegram_id=987657, username=None, title="Private Label")
        session.add(channel)
        await session.commit()
        row = {
            "id": 8, "telegram_channel_id": "987657", "text": "Allowed archive",
            "date": "2026-10-14T10:00:00Z",
        }
        result = await import_tgparser_archive(
            session, channel_id=channel.id, records=[row]
        )
        await session.commit()
        assert result["inserted"] == 1


@pytest.mark.asyncio
async def test_tgparser_cli_rolls_back_whole_archive_when_later_batch_invalid(
    test_app, monkeypatch, tmp_path
):
    """A malformed 501st row must not commit the first 500."""
    import json

    async with test_app.state.sessionmaker() as session:
        channel = TelegramChannel(
            telegram_id=987658, username="batchtest", title="Atomic Import Test"
        )
        session.add(channel)
        await session.commit()
        channel_id = channel.id

    rows = [
        {
            "id": idx,
            "channel": "batchtest",
            "date": "2026-10-14T00:00:00Z",
            "text": f"Message {idx}",
        }
        for idx in range(1, 502)
    ]
    rows[-1]["channel"] = "different_source"
    archive = tmp_path / "multi_batch.json"
    archive.write_text(json.dumps(rows), encoding="utf-8")

    class FakeEngine:
        async def dispose(self):
            pass

    monkeypatch.setattr(telegram_import_tgparser, "get_settings", lambda: None)
    monkeypatch.setattr(
        telegram_import_tgparser,
        "create_engine_and_sessionmaker",
        lambda _settings: (FakeEngine(), test_app.state.sessionmaker),
    )
    with pytest.raises(ValueError, match="Archive username"):
        await telegram_import_tgparser.run(archive, channel_id)

    async with test_app.state.sessionmaker() as session:
        count = (
            await session.execute(
                select(func.count(TelegramMessage.id)).where(
                    TelegramMessage.channel_id == channel_id
                )
            )
        ).scalar_one()
    assert count == 0
