from __future__ import annotations

import csv
import gzip
import json
from pathlib import Path

import pytest

from app.services.teragram_scanner import (
    TERAGRAM_PREVIEW_RECORD_ID,
    TERAGRAM_PREVIEW_VERSION,
    discover_teragram_sources,
    scan_teragram_dataset,
)


pytest.importorskip("duckdb")

ADDR_1 = "3jX8p8QumtfccakGib95yi4pPDNgQnDJEMmwjk1Upump"
ADDR_2 = "DksAcB4w38E7bfzQ2KbjwG3sf95vUPWX9x7rhniwpump"


def _write_csv(path: Path, fieldnames: list[str], rows: list[dict[str, object]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def _write_csv_gz(
    path: Path,
    fieldnames: list[str],
    rows: list[dict[str, object]],
) -> None:
    with gzip.open(path, "wt", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)




def _base_tables(root: Path) -> None:
    _write_csv(
        root / "chats.csv",
        [
            "id",
            "telegram_id",
            "name",
            "title",
            "type",
            "description",
            "members_count",
            "is_verified",
            "is_scam",
        ],
        [
            {
                "id": 1,
                "telegram_id": -1001,
                "name": "solana_calls",
                "title": "Solana Meme Calls",
                "type": "CHANNEL",
                "description": "Solana memecoin alpha and gems",
                "members_count": 12345,
                "is_verified": False,
                "is_scam": False,
            },
            {
                "id": 2,
                "telegram_id": -1002,
                "name": "gaming_mods",
                "title": "Game Modding",
                "type": "CHANNEL",
                "description": "Mods and maps",
                "members_count": 5000,
                "is_verified": False,
                "is_scam": False,
            },
        ],
    )
    _write_csv(
        root / "messages.csv",
        ["id", "chat_id", "forward_from_id", "forward_from_chat_id"],
        [
            {"id": 11, "chat_id": 1, "forward_from_id": "", "forward_from_chat_id": ""},
            {"id": 12, "chat_id": 1, "forward_from_id": "", "forward_from_chat_id": 99},
            {"id": 21, "chat_id": 2, "forward_from_id": "", "forward_from_chat_id": ""},
        ],
    )


def test_discovers_preview_csv_layout(tmp_path: Path) -> None:
    _base_tables(tmp_path)
    sources = discover_teragram_sources(tmp_path)

    assert sources.chats == ((tmp_path / "chats.csv").resolve(),)
    assert sources.messages == ((tmp_path / "messages.csv").resolve(),)
    assert not sources.has_content
    assert not sources.has_entities


def test_current_preview_release_metadata() -> None:
    assert TERAGRAM_PREVIEW_RECORD_ID == 21998264
    assert TERAGRAM_PREVIEW_VERSION == "1.0"




def test_discovers_official_v1_compressed_messages_and_audience_tables(
    tmp_path: Path,
) -> None:
    _base_tables(tmp_path)


    messages = tmp_path / "messages.csv"
    rows = list(csv.DictReader(messages.open(encoding="utf-8")))


    _write_csv_gz(
        tmp_path / "messages.csv.gz",
        ["id", "chat_id", "forward_from_id", "forward_from_chat_id"],
        rows,
    )
    messages.unlink()


    _write_csv(
        tmp_path / "users.csv",
        ["id", "name", "is_bot"],
        [{"id": 100, "name": "hashed-user", "is_bot": False}],
    )
    _write_csv(
        tmp_path / "chats_users.csv",
        ["chat_id", "user_id", "joined", "status"],
        [{"chat_id": 1, "user_id": 100, "joined": "", "status": "member"}],
    )


    sources = discover_teragram_sources(tmp_path)


    assert sources.messages == ((tmp_path / "messages.csv.gz").resolve(),)
    assert sources.users == ((tmp_path / "users.csv").resolve(),)
    assert sources.chats_users == ((tmp_path / "chats_users.csv").resolve(),)




def test_scan_reads_messages_csv_gz_directly(tmp_path: Path) -> None:
    _base_tables(tmp_path)


    messages = tmp_path / "messages.csv"
    rows = list(csv.DictReader(messages.open(encoding="utf-8")))


    _write_csv_gz(
        tmp_path / "messages.csv.gz",
        ["id", "chat_id", "forward_from_id", "forward_from_chat_id"],
        rows,
    )
    messages.unlink()


    _write_csv(
        tmp_path / "hashtags.csv",
        ["entity_id", "message_id", "hashtag"],
        [
            {"entity_id": 1, "message_id": 11, "hashtag": "solana"},
            {"entity_id": 2, "message_id": 12, "hashtag": "memecoin"},
        ],
    )
    _write_csv(
        tmp_path / "entity_urls.csv",
        ["entity_id", "message_id", "url"],
        [
            {
                "entity_id": 10,
                "message_id": 11,
                "url": f"https://pump.fun/{ADDR_1}",
            },
            {
                "entity_id": 11,
                "message_id": 12,
                "url": f"https://dexscreener.com/solana/{ADDR_2}",
            },
        ],
    )


    output = tmp_path / "out_gzip"
    summary = scan_teragram_dataset(
        input_dir=tmp_path,
        output_dir=output,
        seed_limit=10,
        signal_source="auto",
        memory_limit="256MB",
    )


    assert summary["signal_source"] == "entities"
    assert summary["candidate_channels"] == 1
    assert summary["sources"]["messages"][0].endswith("messages.csv.gz")




def test_recent_100_excludes_older_entity_signal(tmp_path: Path) -> None:
    _write_csv(
        tmp_path / "chats.csv",
        [
            "id",
            "telegram_id",
            "name",
            "title",
            "type",
            "description",
            "members_count",
        ],
        [
            {
                "id": 1,
                "telegram_id": -100123,
                "name": "ordinary_channel",
                "title": "Ordinary Channel",
                "type": "CHANNEL",
                "description": "General discussion",
                "members_count": 1000,
            }
        ],
    )


    rows = []
    for message_id in range(1, 102):
        rows.append(
            {
                "id": message_id,
                "chat_id": 1,
                "date": f"2026-01-{min(message_id, 28):02d} 12:00:00",
                "forward_from_id": "",
                "forward_from_chat_id": "",
            }
        )


    _write_csv(
        tmp_path / "messages.csv",
        [
            "id",
            "chat_id",
            "date",
            "forward_from_id",
            "forward_from_chat_id",
        ],
        rows,
    )


    # Only the oldest message has crypto evidence.
    _write_csv(
        tmp_path / "entity_urls.csv",
        ["entity_id", "message_id", "url"],
        [
            {
                "entity_id": 1,
                "message_id": 1,
                "url": f"https://pump.fun/{ADDR_1}",
            }
        ],
    )


    output = tmp_path / "recent100"
    summary = scan_teragram_dataset(
        input_dir=tmp_path,
        output_dir=output,
        seed_limit=10,
        recent_messages_per_chat=100,
        signal_source="auto",
        memory_limit="256MB",
    )


    assert summary["recent_messages_per_chat"] == 100
    assert summary["candidate_channels"] == 0
    assert summary["seed_channels"] == 0




def test_content_scan_reuses_exact_existing_scoring(tmp_path: Path) -> None:
    _base_tables(tmp_path)
    _write_csv(
        tmp_path / "message_content.csv",
        ["message_id", "text", "caption"],
        [
            {
                "message_id": 11,
                "text": f"New Solana gem CA {ADDR_1} entry now",
                "caption": "",
            },
            {
                "message_id": 12,
                "text": f"Another memecoin call CA {ADDR_2} 10x setup",
                "caption": "",
            },
            {"message_id": 21, "text": "New texture pack released today", "caption": ""},
        ],
    )

    output = tmp_path / "out"
    summary = scan_teragram_dataset(
        input_dir=tmp_path,
        output_dir=output,
        seed_limit=10,
        signal_source="auto",
        memory_limit="256MB",
    )

    assert summary["preview_record_id"] == TERAGRAM_PREVIEW_RECORD_ID
    assert summary["signal_source"] == "content"
    assert summary["candidate_channels"] == 1
    assert summary["signal_rows_exactly_scored"] == 2

    candidates = [
        json.loads(line)
        for line in (output / "teragram_candidates.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    assert len(candidates) == 1
    row = candidates[0]
    assert row["username"] == "solana_calls"
    assert row["channel_id"] == "-1001"
    assert row["teragram_chat_id"] == "1"
    assert "crypto" in row["classifications"]
    assert "memecoin" in row["classifications"]
    assert "solana" in row["classifications"]
    assert "caller" in row["classifications"]
    assert row["signals"]["unique_solana_mints"] == 2
    assert row["signals"]["messages_total"] == 2
    assert row["signals"]["forwarded_messages"] == 1

    seed = json.loads((output / "telegram_seed_database.json").read_text(encoding="utf-8"))
    assert seed["source"] == "teragram"
    assert seed["channels"][0]["username"] == "solana_calls"
    assert seed["channels"][0]["channel_id"] == "-1001"
    assert seed["channels"][0]["teragram_chat_id"] == "1"


def test_auto_falls_back_to_entities_when_text_is_unavailable(tmp_path: Path) -> None:
    _base_tables(tmp_path)
    _write_csv(
        tmp_path / "entity_urls.csv",
        ["entity_id", "message_id", "url"],
        [
            {
                "entity_id": 1,
                "message_id": 11,
                "url": f"https://pump.fun/{ADDR_1}",
            },
            {
                "entity_id": 2,
                "message_id": 12,
                "url": f"https://dexscreener.com/solana/{ADDR_2}",
            },
        ],
    )
    _write_csv(
        tmp_path / "entity_hashtags.csv",
        ["entity_id", "message_id", "hashtag"],
        [
            {"entity_id": 10, "message_id": 11, "hashtag": "solana"},
            {"entity_id": 11, "message_id": 12, "hashtag": "memecoin"},
        ],
    )

    output = tmp_path / "out_entities"
    summary = scan_teragram_dataset(
        input_dir=tmp_path,
        output_dir=output,
        seed_limit=10,
        signal_source="auto",
        memory_limit="256MB",
    )

    assert summary["signal_source"] == "entities"
    assert summary["candidate_channels"] == 1
    seed = json.loads((output / "telegram_seed_database.json").read_text(encoding="utf-8"))
    assert seed["channels"][0]["username"] == "solana_calls"


def test_metadata_mode_does_not_fake_message_evidence(tmp_path: Path) -> None:
    _base_tables(tmp_path)
    output = tmp_path / "out_metadata"

    summary = scan_teragram_dataset(
        input_dir=tmp_path,
        output_dir=output,
        seed_limit=10,
        signal_source="metadata",
        memory_limit="256MB",
    )

    assert summary["signal_source"] == "metadata"
    assert summary["prefiltered_chats"] == 1
    assert summary["candidate_channels"] == 0
    seed = json.loads((output / "telegram_seed_database.json").read_text(encoding="utf-8"))
    assert seed["channels"] == []


def test_historical_native_burst_same_day_is_not_root() -> None:
    import duckdb

    from app.services import teragram_scanner as scanner

    connection = duckdb.connect(":memory:")

    try:
        connection.execute(
            """
            CREATE TABLE tg_messages (
                id BIGINT,
                chat_id BIGINT,
                date TIMESTAMP
            )
            """
        )

        connection.execute(
            """
            CREATE TABLE tg_entity_urls (
                entity_id BIGINT,
                message_id BIGINT,
                url VARCHAR
            )
            """
        )

        connection.execute(
            """
            CREATE TABLE tg_entity_hashtags (
                entity_id BIGINT,
                message_id BIGINT,
                hashtag VARCHAR
            )
            """
        )

        rows = [
            (
                10000 + i,
                147,
                f"2025-05-{((i % 20) + 1):02d} 10:00:00",
            )
            for i in range(166)
        ]

        rows[0] = (
            10000,
            147,
            "2025-05-09 14:24:13",
        )
        rows[1] = (
            10001,
            147,
            "2025-05-09 14:24:19",
        )

        connection.executemany(
            "INSERT INTO tg_messages VALUES (?, ?, ?)",
            rows,
        )

        connection.executemany(
            "INSERT INTO tg_entity_urls VALUES (?, ?, ?)",
            [
                (
                    1,
                    10000,
                    "https://pump.fun/coin/"
                    "DaEUPVqGjt3SKEREJaHCgKtkjiTPJNYAhuyKEXZ6pump",
                ),
                (
                    2,
                    10001,
                    "https://pump.fun/",
                ),
            ],
        )

        columns = {
            "tg_messages": {
                "id",
                "chat_id",
                "date",
            },
            "tg_entity_urls": {
                "entity_id",
                "message_id",
                "url",
            },
            "tg_entity_hashtags": {
                "entity_id",
                "message_id",
                "hashtag",
            },
        }

        scanner._create_historical_root_table(
            connection,
            columns,
            window_days=180,
            density_threshold=0.005,
        )

        roots = connection.execute(
            """
            SELECT chat_id
            FROM tg_historical_roots
            WHERE chat_id = 147
            """
        ).fetchall()

        assert roots == []

    finally:
        connection.close()
def test_memecoin_hype_suffix_is_not_exact_historical_target() -> None:
    import duckdb

    from app.services import teragram_scanner as scanner

    connection = duckdb.connect(":memory:")

    try:
        connection.execute(
            """
            CREATE TABLE tg_messages (
                id BIGINT,
                chat_id BIGINT,
                date TIMESTAMP
            )
            """
        )

        connection.execute(
            """
            CREATE TABLE tg_entity_urls (
                entity_id BIGINT,
                message_id BIGINT,
                url VARCHAR
            )
            """
        )

        connection.execute(
            """
            CREATE TABLE tg_entity_hashtags (
                entity_id BIGINT,
                message_id BIGINT,
                hashtag VARCHAR
            )
            """
        )

        connection.executemany(
            "INSERT INTO tg_messages VALUES (?, ?, ?)",
            [
                (1, 99, "2025-05-01 00:00:00"),
                (2, 99, "2025-05-02 00:00:00"),
                (3, 99, "2025-05-03 00:00:00"),
            ],
        )

        connection.executemany(
            "INSERT INTO tg_entity_hashtags VALUES (?, ?, ?)",
            [
                (1, 1, "memecoinhype"),
                (2, 2, "memecoinhype"),
                (3, 3, "memecoinhype"),
            ],
        )

        columns = {
            "tg_messages": {"id", "chat_id", "date"},
            "tg_entity_urls": {
                "entity_id",
                "message_id",
                "url",
            },
            "tg_entity_hashtags": {
                "entity_id",
                "message_id",
                "hashtag",
            },
        }

        scanner._create_historical_root_table(
            connection,
            columns,
            window_days=180,
            density_threshold=0.005,
        )

        count = connection.execute(
            "SELECT COUNT(*) FROM tg_historical_roots"
        ).fetchone()[0]

        assert count == 0

    finally:
        connection.close()


def test_historical_repeated_target_across_days_is_root() -> None:
    import duckdb

    from app.services import teragram_scanner as scanner

    connection = duckdb.connect(":memory:")

    try:
        connection.execute(
            """
            CREATE TABLE tg_messages (
                id BIGINT,
                chat_id BIGINT,
                date TIMESTAMP
            )
            """
        )

        connection.execute(
            """
            CREATE TABLE tg_entity_urls (
                entity_id BIGINT,
                message_id BIGINT,
                url VARCHAR
            )
            """
        )

        connection.execute(
            """
            CREATE TABLE tg_entity_hashtags (
                entity_id BIGINT,
                message_id BIGINT,
                hashtag VARCHAR
            )
            """
        )

        rows = [
            (
                20000 + i,
                6017,
                f"2025-02-{((i % 20) + 1):02d} 10:00:00",
            )
            for i in range(200)
        ]

        connection.executemany(
            "INSERT INTO tg_messages VALUES (?, ?, ?)",
            rows,
        )

        connection.executemany(
            "INSERT INTO tg_entity_urls VALUES (?, ?, ?)",
            [
                (
                    1,
                    20001,
                    "https://coinmarketcap.com/dexscan/solana/token-a",
                ),
                (
                    2,
                    20002,
                    "https://coinmarketcap.com/dexscan/solana/token-a",
                ),
                (
                    3,
                    20003,
                    "https://solscan.io/token/token-a",
                ),
            ],
        )

        connection.executemany(
            "INSERT INTO tg_entity_hashtags VALUES (?, ?, ?)",
            [
                (10, 20004, "memecoin"),
                (11, 20005, "solana"),
            ],
        )

        columns = {
            "tg_messages": {
                "id",
                "chat_id",
                "date",
            },
            "tg_entity_urls": {
                "entity_id",
                "message_id",
                "url",
            },
            "tg_entity_hashtags": {
                "entity_id",
                "message_id",
                "hashtag",
            },
        }

        scanner._create_historical_root_table(
            connection,
            columns,
            window_days=180,
            density_threshold=0.005,
        )

        row = connection.execute(
            """
            SELECT
                target_messages,
                target_days,
                admission_path
            FROM tg_historical_roots
            WHERE chat_id = 6017
            """
        ).fetchone()

        assert row is not None
        assert row[0] >= 3
        assert row[1] >= 2
        assert row[2] == "repeated"

    finally:
        connection.close()
