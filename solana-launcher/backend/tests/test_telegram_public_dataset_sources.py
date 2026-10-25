import json
from pathlib import Path

import pytest
from app.models.social_intelligence import TelegramChannel
from app.services.telegram_discovery_registry import (
    due_registry_channels,
    import_dataset_channel_candidates,
)
from app.services.telegram_public_dataset_sources import (
    iter_local_dataset_channels,
    parse_public_channel_snapshot,
    parse_recommendation_edges,
    sync_public_dataset_channels,
)
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


def test_public_snapshot_normalizes_handles_filters_topics_and_sorts() -> None:
    csv_text = (
        "week,measured_on,username,title,topic,subscribers,verified,"
        "posts_per_day,recommended_by\n"
        "2026-W36,2026-08-31,@SolanaCalls,Solana Calls,crypto,1200,1,2.5,7\n"
        "2026-W36,2026-08-31,FinanceFeed,Finance Feed,finance,800,0,3.0,2\n"
        "2026-W36,2026-08-31,GeneralNews,General News,regional-en,900000,1,20,99\n"
        "2026-W36,2026-08-31,solanacalls,Duplicate,crypto,100,0,1,0\n"
    )

    rows = parse_public_channel_snapshot(csv_text, allowed_topics={"crypto", "finance"})

    assert [row["username"] for row in rows] == ["solanacalls", "financefeed"]
    assert rows[0]["participants"] == 1200
    assert rows[0]["verified"] is True
    assert rows[0]["license"] == "CC-BY-4.0"


def test_recommendation_graph_only_expands_relevant_sources_and_deduplicates() -> None:
    csv_text = """source_username,recommended_username
solanacalls,linkedcrypto
solanacalls,linkedcrypto
financefeed,financeneighbor
unrelated,noisechannel
"""
    rows = parse_recommendation_edges(
        csv_text,
        relevant_usernames={"solanacalls"},
        existing_usernames={"solanacalls"},
        limit=10,
    )

    assert [row["username"] for row in rows] == ["linkedcrypto"]
    assert rows[0]["topic"] == "crypto-recommendation"
    assert rows[0]["recommended_from_dataset"] == "solanacalls"


def test_local_json_dataset_import_is_bounded_and_keeps_source_metadata(tmp_path: Path) -> None:
    path = tmp_path / "channels.json"
    path.write_text(
        json.dumps(
            {
                "channels": [
                    {"username": "@AlphaCalls", "title": "Alpha Calls", "topic": "crypto"},
                    {"username": "https://t.me/BetaCalls/1", "title": "Beta Calls"},
                    {"title": "Missing username"},
                ]
            }
        ),
        encoding="utf-8",
    )

    rows = list(iter_local_dataset_channels(path, limit=1, source_name="unit-test-source"))

    assert len(rows) == 1
    assert rows[0]["username"] == "alphacalls"
    assert rows[0]["source_name"] == "unit-test-source"
    assert rows[0]["topic"] == "crypto"


def test_local_tgdataset_topic_labels_filter_to_crypto(tmp_path: Path) -> None:
    dataset_dir = tmp_path / "tgdataset"
    labeled_dir = dataset_dir / "labeled_data"
    labeled_dir.mkdir(parents=True)
    (labeled_dir / "ch_to_topic_mapping.csv").write_text(
        "ch_ID,topic\n123,Crypto\n456,Entertainment\n", encoding="utf-8"
    )
    (dataset_dir / "channels.json").write_text(
        json.dumps(
            {
                "123": {"username": "CryptoFeed", "title": "Crypto Feed"},
                "456": {"username": "EntertainmentFeed", "title": "Entertainment Feed"},
            }
        ),
        encoding="utf-8",
    )

    rows = list(
        iter_local_dataset_channels(dataset_dir, limit=10, source_name="tgdataset-local")
    )

    assert [row["username"] for row in rows] == ["cryptofeed"]
    assert rows[0]["topic"] == "crypto"
    assert "crypto" in rows[0]["tags"]

    all_topics = list(
        iter_local_dataset_channels(
            dataset_dir, limit=10, source_name="tgdataset-local", topics={"all"}
        )
    )
    assert {row["username"] for row in all_topics} == {"cryptofeed", "entertainmentfeed"}


@pytest.mark.asyncio
async def test_dataset_candidates_share_registry_and_are_idempotent() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(TelegramChannel.__table__.create)
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    try:
        records = [
            {
                "username": "@AlphaCalls",
                "title": "Alpha Calls",
                "topic": "crypto",
                "participants": 100,
                "verified": True,
                "source_name": "snapshot-a",
                "source_url": "https://example.test/dataset",
                "license": "CC-BY-4.0",
            },
            {
                "username": "https://t.me/AlphaCalls/123",
                "title": "Changed title should not overwrite",
                "source_name": "snapshot-a",
            },
            {"username": "ScamCalls", "scam": "true"},
            {"username": "bad"},
        ]
        stats = await import_dataset_channel_candidates(
            sessionmaker, records, source_name="fallback-source"
        )
        again = await import_dataset_channel_candidates(
            sessionmaker, records[:1], source_name="fallback-source"
        )

        async with sessionmaker() as session:
            channels = list((await session.execute(select(TelegramChannel))).scalars().all())
            channel = channels[0]
        due = await due_registry_channels(sessionmaker, limit=10)

        assert stats == {"received": 4, "accepted": 2, "invalid": 1, "scam_skipped": 1}
        assert again["accepted"] == 1
        assert len(channels) == 1
        assert channel.username == "alphacalls"
        assert channel.title == "Alpha Calls"
        assert channel.participants == 100
        assert channel.meta["dataset_sources"] == ["snapshot-a"]
        assert (
            channel.meta["dataset_provenance"]["snapshot-a"]["license"]
            == "CC-BY-4.0"
        )
        assert channel.meta["dataset_tags"] == ["crypto"]
        assert channel.meta["discovery_registry"]["state"] == "candidate"
        assert "alphacalls" in due
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_public_sync_stages_static_seed_and_remote_candidates(monkeypatch) -> None:
    channels_csv = (
        "week,measured_on,username,title,topic,subscribers,verified,"
        "posts_per_day,recommended_by\n"
        "2026-W36,2026-08-31,SolanaCalls,Solana Calls,crypto,1200,1,2.5,7\n"
        "2026-W36,2026-08-31,FinanceFeed,Finance Feed,finance,800,0,3.0,2\n"
        "2026-W36,2026-08-31,GeneralNews,General News,regional-en,900000,1,20,99\n"
    )
    edges_csv = """source_username,recommended_username
solanacalls,linkedcrypto
financefeed,financeneighbor
"""

    async def fake_download(client, url: str) -> str:
        if url.endswith("channels.csv"):
            return channels_csv
        return edges_csv

    monkeypatch.setattr("app.services.telegram_public_dataset_sources._download_csv", fake_download)
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(TelegramChannel.__table__.create)
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)

    class StubSettings:
        telegram_public_web_timeout_seconds = 5
        telegram_dataset_sync_topics = "crypto,finance"
        telegram_dataset_sync_max_channels = 10

    try:
        result = await sync_public_dataset_channels(sessionmaker, StubSettings())
        async with sessionmaker() as session:
            channels = list((await session.execute(select(TelegramChannel))).scalars().all())
        by_username = {row.username: row for row in channels}

        assert result["records"]["accepted"] == 5
        assert set(by_username) == {
            "smugcalls",
            "solanacalls",
            "financefeed",
            "linkedcrypto",
            "financeneighbor",
        }
        assert by_username["solanacalls"].meta["dataset_provenance"][
            "tgatlas-telegram-public-channels-2026-W36"
        ]["license"] == "CC-BY-4.0"
        assert by_username["solanacalls"].meta["dataset_provenance"][
            "tgatlas-telegram-public-channels-2026-W36"
        ]["attribution"] == "tgAtlas"
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_public_csv_stream_rejects_oversized_payload(monkeypatch) -> None:
    import httpx
    from app.services import telegram_public_dataset_sources as public

    class Chunks(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b"1234"
            yield b"5678"
            raise AssertionError("must stop reading after size limit")

    monkeypatch.setattr(public, "MAX_REMOTE_CSV_BYTES", 5)
    transport = httpx.MockTransport(lambda request: httpx.Response(200, stream=Chunks()))
    async with httpx.AsyncClient(transport=transport) as client:
        with pytest.raises(ValueError, match="exceeds 5 bytes"):
            await public._download_csv(client, "https://example.invalid/channels.csv")


def test_automatic_public_sync_defaults_off() -> None:
    from app.core.config import Settings

    assert Settings.model_fields["telegram_dataset_sync_enabled"].default is False


@pytest.mark.asyncio
async def test_large_dataset_preserves_metadata_after_messages_and_rejects_scam(tmp_path) -> None:
    from app.services.telegram_public_dataset_sources import _iter_large_tgdataset_json

    path = tmp_path / "channels.json"
    path.write_text(
        json.dumps({
            "123": {
                "username": "ScamCalls",
                "text_messages": {"1": {"text": "nested bodies must not be retained"}},
                "scam": True,
            },
            "456": {
                "text_messages": {"1": {"username": "not_channel_metadata"}},
                "username": "ValidCalls",
                "title": "Valid channel",
            },
        }),
        encoding="utf-8",
    )
    rows = list(_iter_large_tgdataset_json(path))
    assert rows == [
        {"channel_id": "123", "username": "ScamCalls", "scam": True},
        {"channel_id": "456", "username": "ValidCalls", "title": "Valid channel"},
    ]
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(TelegramChannel.__table__.create)
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    try:
        stats = await import_dataset_channel_candidates(sessionmaker, rows, source_name="local")
        assert stats == {"received": 2, "accepted": 1, "invalid": 0, "scam_skipped": 1}
        async with sessionmaker() as session:
            channels = (await session.execute(select(TelegramChannel))).scalars().all()
        assert [channel.username for channel in channels] == ["validcalls"]
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_public_sync_preserves_other_source_after_csv_parser_failure(monkeypatch) -> None:
    import csv
    from types import SimpleNamespace

    async def oversized_field(client, url):
        field = "x" * (csv.field_size_limit() + 1)
        return f"username,title,topic\nValidCalls,{field},crypto\n"

    monkeypatch.setattr(
        "app.services.telegram_public_dataset_sources._download_csv", oversized_field
    )
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(TelegramChannel.__table__.create)
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    try:
        result = await sync_public_dataset_channels(sessionmaker, SimpleNamespace())
        assert result["records"]["accepted"] == 1
        assert len(result["errors"]) == 1
        assert "field larger than field limit" in result["errors"][0]["error"]
        async with sessionmaker() as session:
            channels = (await session.execute(select(TelegramChannel))).scalars().all()
        assert [channel.username for channel in channels] == ["smugcalls"]
    finally:
        await engine.dispose()
