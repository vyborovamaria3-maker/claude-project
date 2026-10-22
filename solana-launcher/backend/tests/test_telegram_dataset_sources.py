import asyncio
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

from app.models.social_intelligence import TelegramChannel, TelegramDatasetImportCheckpoint
from app.services.telegram_dataset_sources import (
    _normalize_candidate,
    dataset_manifest,
    discover_dataset_files,
    import_dataset_candidates,
)
from app.services.telegram_discovery_registry import due_registry_channels, record_discovery_results
from app.services.telegram_runtime import TelegramMonitorManager
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


class StubSettings:
    telegram_dataset_import_enabled = True
    telegram_public_web_seed_database = ""
    telegram_public_web_dataset_paths = ""


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n",
        encoding="utf-8",
    )


def test_dataset_file_discovery_includes_explicit_files_and_seed_database(tmp_path: Path) -> None:
    seed = tmp_path / "seed.json"
    seed.write_text(json.dumps({"channels": [{"username": "alpha_calls"}]}), encoding="utf-8")
    custom = tmp_path / "custom"
    _write_jsonl(custom / "extra.jsonl", [{"username": "beta_calls"}])
    settings = StubSettings()
    settings.telegram_public_web_seed_database = str(seed)
    settings.telegram_public_web_dataset_paths = str(custom)

    paths = discover_dataset_files(settings)
    assert seed.resolve() in paths
    assert (custom / "extra.jsonl").resolve() in paths
    manifest = dataset_manifest(settings)
    expected_paths = {str(seed.resolve()), str((custom / "extra.jsonl").resolve())}
    assert {entry[0] for entry in manifest} >= expected_paths


def test_candidate_normalization_accepts_public_urls_and_rejects_private_or_scam_rows() -> None:
    candidate = _normalize_candidate(
        {
            "channel_url": "https://t.me/s/Alpha_Calls/123",
            "classifications": "Solana;memecoin",
            "seed_score": "72.5",
        },
        source="custom",
        source_file="extra.jsonl",
    )
    assert candidate is not None
    assert candidate["username"] == "alpha_calls"
    assert candidate["classifications"] == ["solana", "memecoin"]
    assert candidate["seed_score"] == 72.5
    assert (
        _normalize_candidate(
            {"username": "https://t.me/+privateinvite", "seed_score": 99},
            source="custom",
            source_file="extra.jsonl",
        )
        is None
    )
    assert (
        _normalize_candidate(
            {"username": "scam_calls", "scam": "true"},
            source="custom",
            source_file="extra.jsonl",
        )
        is None
    )


def test_dataset_import_merges_sources_and_queues_public_channels(tmp_path: Path) -> None:
    tgdataset = tmp_path / "tgdataset" / "TGDataset_1.tar.gz.candidates.jsonl"
    teragram = tmp_path / "teragram" / "telegram_seed_database.json"
    _write_jsonl(
        tgdataset,
        [
            {
                "username": "@Alpha_Calls",
                "title": "Alpha Calls",
                "seed_score": 72,
                "classifications": ["solana", "caller"],
                "n_subscribers": 1200,
            },
            {"username": "scam_calls", "scam": True, "seed_score": 99},
            {"username": "bad name", "seed_score": 30},
        ],
    )
    teragram.parent.mkdir(parents=True, exist_ok=True)
    teragram.write_text(
        json.dumps(
            {
                "source": "teragram",
                "channels": [
                    {
                        "username": "https://t.me/alpha_calls",
                        "seed_score": 88,
                        "classifications": ["memecoin", "solana_memecoin"],
                        "n_subscribers": 1600,
                    },
                    {"username": "beta_calls", "seed_score": 65, "classifications": ["caller"]},
                ],
            }
        ),
        encoding="utf-8",
    )

    async def run_test() -> None:
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with engine.begin() as connection:
            await connection.run_sync(TelegramChannel.__table__.create)
        sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
        try:
            summary = await import_dataset_candidates(
                sessionmaker,
                StubSettings(),
                paths=[tgdataset, teragram],
            )
            assert summary["files"] == 2
            assert summary["inserted"] == 2
            assert summary["updated"] == 1
            assert summary["records_skipped"] == 2

            async with sessionmaker() as session:
                rows = list((await session.execute(select(TelegramChannel))).scalars().all())
                by_username = {row.username: row for row in rows}
                assert set(by_username) == {"alpha_calls", "beta_calls"}
                alpha = by_username["alpha_calls"]
                alpha_meta = alpha.meta["dataset_import"]
                assert set(alpha_meta["sources"]) == {
                    "tgdataset:tgdataset/TGDataset_1.tar.gz.candidates.jsonl",
                    "teragram:teragram/telegram_seed_database.json",
                }
                assert alpha_meta["classifications"] == [
                    "caller",
                    "memecoin",
                    "solana",
                    "solana_memecoin",
                ]
                assert alpha_meta["seed_score"] == 88
                assert alpha.participants == 1600
                assert alpha.meta["discovery_registry"]["state"] == "candidate"
                assert alpha.meta["discovery_registry"]["source"] == "tgdataset"

            due = await due_registry_channels(
                sessionmaker,
                limit=10,
                sources={"tgdataset", "teragram", "custom"},
            )
            assert set(due) == {"alpha_calls", "beta_calls"}

            await record_discovery_results(
                sessionmaker,
                [{"username": "beta_calls", "posts_saved": 10}],
                database_channels={"beta_calls"},
            )
            async with sessionmaker() as session:
                beta = (
                    await session.execute(
                        select(TelegramChannel).where(TelegramChannel.username == "beta_calls")
                    )
                ).scalar_one()
                assert beta.meta["discovery_registry"]["source"] == "teragram"

            for _ in range(8):
                await record_discovery_results(
                    sessionmaker,
                    [{"username": "beta_calls", "error": "channel unavailable"}],
                )
            async with sessionmaker() as session:
                beta = (
                    await session.execute(
                        select(TelegramChannel).where(TelegramChannel.username == "beta_calls")
                    )
                ).scalar_one()
                assert beta.is_active is False

            await import_dataset_candidates(sessionmaker, StubSettings(), paths=[teragram])
            async with sessionmaker() as session:
                beta = (
                    await session.execute(
                        select(TelegramChannel).where(TelegramChannel.username == "beta_calls")
                    )
                ).scalar_one()
                assert beta.is_active is False
                assert beta.meta["discovery_registry"]["state"] == "unavailable"
        finally:
            await engine.dispose()

    asyncio.run(run_test())



def test_dataset_provenance_keeps_graph_discoveries_in_dataset_queue_but_not_manual_channels() -> None:
    async def run_test() -> None:
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with engine.begin() as connection:
            await connection.run_sync(TelegramChannel.__table__.create)
        sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
        now = datetime.now(UTC).isoformat()
        provenance = {"dataset_import": {"sources": {"tgdataset:channels.jsonl": {"seed_score": 70}}}}
        try:
            async with sessionmaker() as session:
                session.add_all(
                    [
                        TelegramChannel(
                            telegram_id=-101,
                            username="graph_dataset",
                            title="Graph dataset",
                            entity_type="channel",
                            participants=0,
                            about="",
                            is_active=True,
                            first_seen_at=datetime.now(UTC),
                            last_seen_at=datetime.now(UTC),
                            last_scanned_at=None,
                            meta={
                                **provenance,
                                "discovery_registry": {
                                    "source": "graph",
                                    "state": "candidate",
                                    "next_check_at": now,
                                },
                            },
                        ),
                        TelegramChannel(
                            telegram_id=-102,
                            username="manual_dataset",
                            title="Manual dataset",
                            entity_type="channel",
                            participants=0,
                            about="",
                            is_active=True,
                            first_seen_at=datetime.now(UTC),
                            last_seen_at=datetime.now(UTC),
                            last_scanned_at=None,
                            meta={
                                **provenance,
                                "discovery_registry": {
                                    "source": "manual",
                                    "state": "candidate",
                                    "next_check_at": now,
                                },
                            },
                        ),
                        TelegramChannel(
                            telegram_id=-103,
                            username="graph_only",
                            title="Graph only",
                            entity_type="channel",
                            participants=0,
                            about="",
                            is_active=True,
                            first_seen_at=datetime.now(UTC),
                            last_seen_at=datetime.now(UTC),
                            last_scanned_at=None,
                            meta={
                                "discovery_registry": {
                                    "source": "graph",
                                    "state": "candidate",
                                    "next_check_at": now,
                                }
                            },
                        ),
                    ]
                )
                await session.commit()

            due = await due_registry_channels(
                sessionmaker,
                limit=10,
                sources={"tgdataset", "teragram", "custom"},
            )
            assert due == ["graph_dataset"]
        finally:
            await engine.dispose()

    asyncio.run(run_test())


def test_dataset_manifest_checkpoint_survives_restart_and_tracks_changes_and_removals(
    tmp_path: Path,
) -> None:
    custom = tmp_path / "custom"
    source = custom / "channels.jsonl"
    _write_jsonl(source, [{"username": "alpha_calls", "seed_score": 72}])
    settings = StubSettings()
    settings.telegram_public_web_dataset_paths = str(custom)

    async def run_test() -> None:
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with engine.begin() as connection:
            await connection.run_sync(TelegramChannel.__table__.create)
            await connection.run_sync(TelegramDatasetImportCheckpoint.__table__.create)
        sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
        try:
            first_process = TelegramMonitorManager(settings, sessionmaker)
            await first_process._import_dataset_sources_if_changed()
            assert first_process._dataset_import_summary["inserted"] == 1

            async with sessionmaker() as session:
                alpha = (
                    await session.execute(
                        select(TelegramChannel).where(TelegramChannel.username == "alpha_calls")
                    )
                ).scalar_one()
                original_imported_at = alpha.meta["dataset_import"]["last_imported_at"]

            # A fresh manager has no in-memory signature, so it must restore the database
            # checkpoint and skip parsing an unchanged candidate file.
            restarted_process = TelegramMonitorManager(settings, sessionmaker)
            await restarted_process._import_dataset_sources_if_changed()
            assert restarted_process._dataset_import_summary["checkpoint_restored"] is True
            async with sessionmaker() as session:
                alpha = (
                    await session.execute(
                        select(TelegramChannel).where(TelegramChannel.username == "alpha_calls")
                    )
                ).scalar_one()
                assert alpha.meta["dataset_import"]["last_imported_at"] == original_imported_at

            _write_jsonl(
                source,
                [
                    {"username": "alpha_calls", "seed_score": 72},
                    {"username": "beta_calls", "seed_score": 65},
                ],
            )
            await restarted_process._import_dataset_sources_if_changed()
            assert restarted_process._dataset_import_summary["changed_files"] == 1
            assert restarted_process._dataset_import_summary["inserted"] == 1

            source.unlink()
            await restarted_process._import_dataset_sources_if_changed()
            assert restarted_process._dataset_import_summary["removed_files"] == ["channels.jsonl"]
            async with sessionmaker() as session:
                checkpoints = list(
                    (
                        await session.execute(select(TelegramDatasetImportCheckpoint))
                    )
                    .scalars()
                    .all()
                )
                usernames = set(
                    (
                        await session.execute(select(TelegramChannel.username))
                    )
                    .scalars()
                    .all()
                )
                assert checkpoints == []
                # Removing an input file removes its checkpoint, not historical channel evidence.
                assert usernames == {"alpha_calls", "beta_calls"}
        finally:
            await engine.dispose()

    asyncio.run(run_test())
