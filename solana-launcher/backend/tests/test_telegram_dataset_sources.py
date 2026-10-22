import asyncio
import json
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.social_intelligence import TelegramChannel
from app.services.telegram_dataset_sources import (
    _normalize_candidate,
    dataset_manifest,
    discover_dataset_files,
    import_dataset_candidates,
)
from app.services.telegram_discovery_registry import due_registry_channels, record_discovery_results


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
        finally:
            await engine.dispose()

    asyncio.run(run_test())
