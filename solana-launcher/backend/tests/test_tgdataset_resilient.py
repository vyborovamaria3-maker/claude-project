from __future__ import annotations

import io
import json
import tarfile

import pytest

from app.services import tgdataset_resilient


def _tar_bytes() -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for index in (1, 2):
            payload = b"{}"
            info = tarfile.TarInfo(f"TGDataset/channels_{index:03d}.json")
            info.size = len(payload)
            archive.addfile(info, io.BytesIO(payload))
    return output.getvalue()


def _candidate(username: str) -> dict:
    return {
        "username": username,
        "classifications": ["solana"],
        "signals": {"messages_total": 10},
    }


def test_resumable_scan_rolls_back_interrupted_member_and_skips_completed_json(monkeypatch, tmp_path) -> None:
    calls = 0

    def flaky(_fileobj):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise TimeoutError("simulated network stall")
        yield _candidate("first")

    monkeypatch.setattr(tgdataset_resilient, "iter_tgdataset_channels", flaky)
    checkpoint_path = tmp_path / "scan.checkpoint.json"
    output_path = tmp_path / "candidates.partial"
    checkpoint = {
        "version": 1,
        "archive": "TGDataset_1.tar.gz",
        "completed_json_members": 0,
        "candidate_bytes": 0,
        "stats": {
            "archive": "TGDataset_1.tar.gz",
            "json_members": 0,
            "channels_scanned": 0,
            "candidates": 0,
            "messages_scanned": 0,
        },
    }

    with output_path.open("w+b") as output:
        with pytest.raises(TimeoutError):
            tgdataset_resilient.scan_tar_stream_resumable(
                io.BytesIO(_tar_bytes()),
                archive_name="TGDataset_1.tar.gz",
                output=output,
                checkpoint_path=checkpoint_path,
                checkpoint=checkpoint,
            )

    saved = json.loads(checkpoint_path.read_text(encoding="utf-8"))
    assert saved["completed_json_members"] == 1
    assert saved["stats"]["channels_scanned"] == 1
    assert len(output_path.read_text(encoding="utf-8").splitlines()) == 1

    def stable(_fileobj):
        yield _candidate("second")

    monkeypatch.setattr(tgdataset_resilient, "iter_tgdataset_channels", stable)
    with output_path.open("r+b") as output:
        output.seek(saved["candidate_bytes"])
        stats, completed, stopped = tgdataset_resilient.scan_tar_stream_resumable(
            io.BytesIO(_tar_bytes()),
            archive_name="TGDataset_1.tar.gz",
            output=output,
            checkpoint_path=checkpoint_path,
            checkpoint=saved,
        )

    assert stopped is False
    assert completed == 2
    assert stats.json_members == 2
    assert stats.channels_scanned == 2
    assert stats.candidates == 2
    rows = [json.loads(line) for line in output_path.read_text(encoding="utf-8").splitlines()]
    assert [row["username"] for row in rows] == ["first", "second"]
