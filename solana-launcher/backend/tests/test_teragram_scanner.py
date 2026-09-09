from __future__ import annotations

import csv
import json
from pathlib import Path

import pytest

from app.services.teragram_scanner import (
    TERAGRAM_PREVIEW_RECORD_ID,
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
