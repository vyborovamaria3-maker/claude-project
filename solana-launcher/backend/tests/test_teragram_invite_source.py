from __future__ import annotations

import json

from app.services.teragram_invite_source import (
    get_teragram_invite_status,
    list_teragram_invite_channels,
)


def test_status_is_safe_when_scan_has_not_run(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("TG_TERAGRAM_OUTPUT_DIR", str(tmp_path))

    status = get_teragram_invite_status()

    assert status["ready"] is False
    assert status["seed_channels"] == 0
    assert status["candidate_channels"] == 0
    assert status["source"]["preview_record_id"] == 21998264


def test_invite_source_reads_and_filters_seed_database(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("TG_TERAGRAM_OUTPUT_DIR", str(tmp_path))
    (tmp_path / "summary.json").write_text(
        json.dumps(
            {
                "generated_at": "2026-09-10T12:00:00+00:00",
                "signal_source": "entities",
                "chats_total": 700000,
                "prefiltered_chats": 12000,
                "candidate_channels": 2400,
                "signal_rows_exactly_scored": 55000,
                "categories": {"solana": 900, "memecoin": 1100, "caller": 400},
            }
        ),
        encoding="utf-8",
    )
    (tmp_path / "telegram_seed_database.json").write_text(
        json.dumps(
            {
                "generated_at": "2026-09-10T12:00:00+00:00",
                "source": "teragram",
                "channels": [
                    {
                        "username": "sol_alpha",
                        "seed_score": 92.5,
                        "scores": {"solana": 98.0},
                        "classifications": ["crypto", "solana", "caller"],
                        "n_subscribers": 10000,
                        "channel_id": "-1001",
                        "teragram_chat_id": "1",
                    },
                    {
                        "username": "eth_memes",
                        "seed_score": 80.0,
                        "scores": {"memecoin": 95.0},
                        "classifications": ["crypto", "memecoin"],
                        "n_subscribers": 5000,
                        "channel_id": "-1002",
                        "teragram_chat_id": "2",
                    },
                ],
            }
        ),
        encoding="utf-8",
    )

    status = get_teragram_invite_status(
        active_seed_database=f"{tmp_path}/telegram_seed_database.json"
    )
    solana, total = list_teragram_invite_channels(limit=10, classification="solana")

    assert status["ready"] is True
    assert status["seed_channels"] == 2
    assert status["candidate_channels"] == 2400
    assert status["categories"]["solana"] == 900
    assert status["active_for_public_discovery"] is True
    assert total == 1
    assert [item["username"] for item in solana] == ["sol_alpha"]


def test_invite_source_rejects_unknown_classification(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("TG_TERAGRAM_OUTPUT_DIR", str(tmp_path))

    try:
        list_teragram_invite_channels(classification="anything")
    except ValueError as exc:
        assert "unsupported" in str(exc)
    else:
        raise AssertionError("unknown classification must be rejected")
