from __future__ import annotations

from pathlib import Path

import pytest
from app.services.teragram_scan_job import (
    TeraGramScanJobManager,
    _build_scan_command,
    _progress_for_line,
)


def test_preview_defaults_to_1000_chats(tmp_path: Path) -> None:
    command, config = _build_scan_command(
        input_dir=tmp_path,
        output_dir=tmp_path / "output",
        mode="preview",
        max_chats=None,
        seed_limit=250,
        signal_source="auto",
        threads=4,
        memory_limit="4GB",
        fetch_size=10_000,
    )

    assert config["max_chats"] == 1000
    assert "--max-chats" in command
    assert command[command.index("--max-chats") + 1] == "1000"
    assert command[command.index("--threads") + 1] == "4"


def test_full_scan_can_have_no_chat_limit(tmp_path: Path) -> None:
    command, config = _build_scan_command(
        input_dir=tmp_path,
        output_dir=tmp_path / "output",
        mode="full",
        max_chats=None,
        seed_limit=500,
        signal_source="entities",
        threads=None,
        memory_limit="16GB",
        fetch_size=20_000,
    )

    assert config["max_chats"] is None
    assert "--max-chats" not in command
    assert config["memory_limit"] == "16GB"


def test_progress_stages_are_derived_from_scanner_output() -> None:
    assert _progress_for_line("TeraGram: discovering CSV/Parquet relations") == (10, "discovering")

    assert _progress_for_line("TeraGram: building disk-backed candidate and message indexes") == (
        45,
        "prefilter",
    )

    assert _progress_for_line("TeraGram: applying exact POTAPoff Telegram parser and scoring") == (
        70,
        "scoring",
    )

    assert _progress_for_line(
        "TeraGram: done; 22 candidates, 15 seed channels, 100 exact signal rows"
    ) == (100, "completed")


def test_second_scan_is_rejected(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("TG_TERAGRAM_INPUT_DIR", str(tmp_path))
    monkeypatch.setenv("TG_TERAGRAM_OUTPUT_DIR", str(tmp_path / "output"))

    class RunningProcess:
        def poll(self):
            return None

    manager = TeraGramScanJobManager()
    manager._process = RunningProcess()  # type: ignore[assignment]

    with pytest.raises(RuntimeError, match="already running"):
        manager.start(mode="preview")
