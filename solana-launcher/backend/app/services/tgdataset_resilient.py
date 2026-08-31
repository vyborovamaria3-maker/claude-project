from __future__ import annotations

import json
import tarfile
import time
from pathlib import Path
from typing import Any, BinaryIO, Callable, Iterable
from urllib.request import Request, urlopen

from app.services.tgdataset_scanner import (
    ArchiveScanStats,
    ZENODO_ARCHIVES,
    ZENODO_RECORD_ID,
    build_outputs,
    iter_tgdataset_channels,
    utcnow_iso,
    zenodo_archive_url,
)


_USER_AGENT = "POTAPoff-TGDataset-Scanner/1.1"


def _checkpoint_path(output_dir: Path, archive_name: str) -> Path:
    return output_dir / f"{archive_name}.checkpoint.json"


def _read_checkpoint(path: Path, archive_name: str) -> dict[str, Any]:
    if not path.exists():
        return {
            "version": 1,
            "archive": archive_name,
            "completed_json_members": 0,
            "candidate_bytes": 0,
            "stats": ArchiveScanStats(archive=archive_name).as_dict(),
        }
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        payload = {}
    if payload.get("archive") != archive_name:
        payload = {}
    stats = payload.get("stats") if isinstance(payload.get("stats"), dict) else {}
    return {
        "version": 1,
        "archive": archive_name,
        "completed_json_members": max(0, int(payload.get("completed_json_members") or 0)),
        "candidate_bytes": max(0, int(payload.get("candidate_bytes") or 0)),
        "stats": {
            "archive": archive_name,
            "json_members": max(0, int(stats.get("json_members") or 0)),
            "channels_scanned": max(0, int(stats.get("channels_scanned") or 0)),
            "candidates": max(0, int(stats.get("candidates") or 0)),
            "messages_scanned": max(0, int(stats.get("messages_scanned") or 0)),
        },
    }


def _write_checkpoint(path: Path, payload: dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def _stats_from_checkpoint(checkpoint: dict[str, Any], archive_name: str) -> ArchiveScanStats:
    stats = checkpoint.get("stats") if isinstance(checkpoint.get("stats"), dict) else {}
    return ArchiveScanStats(
        archive=archive_name,
        json_members=max(0, int(stats.get("json_members") or 0)),
        channels_scanned=max(0, int(stats.get("channels_scanned") or 0)),
        candidates=max(0, int(stats.get("candidates") or 0)),
        messages_scanned=max(0, int(stats.get("messages_scanned") or 0)),
    )


def scan_tar_stream_resumable(
    fileobj: BinaryIO,
    *,
    archive_name: str,
    output: BinaryIO,
    checkpoint_path: Path,
    checkpoint: dict[str, Any],
    max_channels: int | None = None,
    progress: Callable[[str], None] | None = None,
) -> tuple[ArchiveScanStats, int, bool]:
    """Scan a gzip tar stream and checkpoint after every fully parsed JSON member.

    On retry the HTTP gzip stream still has to be read from the beginning, but already completed
    tar members are skipped without JSON parsing. Candidate bytes from an interrupted member are
    rolled back before the exception is propagated, preventing duplicates/corrupt partial output.
    """

    completed_members = max(0, int(checkpoint.get("completed_json_members") or 0))
    stats = _stats_from_checkpoint(checkpoint, archive_name)
    json_member_index = 0
    stopped_early = False

    with tarfile.open(fileobj=fileobj, mode="r|gz") as archive:
        for member in archive:
            if not member.isfile() or not member.name.lower().endswith(".json"):
                continue
            json_member_index += 1
            if json_member_index <= completed_members:
                continue

            extracted = archive.extractfile(member)
            if extracted is None:
                continue
            before_stats = ArchiveScanStats(
                archive=archive_name,
                json_members=stats.json_members,
                channels_scanned=stats.channels_scanned,
                candidates=stats.candidates,
                messages_scanned=stats.messages_scanned,
            )
            member_output_offset = output.tell()
            member_channels = 0
            try:
                for channel in iter_tgdataset_channels(extracted):
                    stats.channels_scanned += 1
                    member_channels += 1
                    stats.messages_scanned += int(channel.get("signals", {}).get("messages_total") or 0)
                    if channel.get("classifications"):
                        stats.candidates += 1
                        output.write(
                            (json.dumps(channel, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
                        )
                    if max_channels is not None and stats.channels_scanned >= max_channels:
                        stopped_early = True
                        break
            except Exception:
                output.seek(member_output_offset)
                output.truncate(member_output_offset)
                output.flush()
                stats = before_stats
                raise

            if stopped_early:
                output.flush()
                break

            stats.json_members += 1
            completed_members = json_member_index
            output.flush()
            checkpoint = {
                "version": 1,
                "archive": archive_name,
                "completed_json_members": completed_members,
                "candidate_bytes": output.tell(),
                "stats": stats.as_dict(),
                "updated_at": utcnow_iso(),
            }
            _write_checkpoint(checkpoint_path, checkpoint)
            if progress is not None:
                progress(
                    f"[{archive_name}] files={stats.json_members} channels={stats.channels_scanned} "
                    f"candidates={stats.candidates} messages={stats.messages_scanned}"
                )

    return stats, completed_members, stopped_early


def _selected_archives(archive_numbers: Iterable[int]) -> list[str]:
    selected: list[str] = []
    for raw in archive_numbers:
        number = int(raw)
        if number not in {1, 2, 3, 4}:
            raise ValueError("Archive numbers must be between 1 and 4")
        name = f"TGDataset_{number}.tar.gz"
        if name not in selected:
            selected.append(name)
    return selected


def scan_archives_resilient(
    *,
    output_dir: str | Path,
    archive_numbers: Iterable[int] = (1, 2, 3, 4),
    local_dir: str | Path | None = None,
    resume: bool = True,
    seed_limit: int = 250,
    max_channels: int | None = None,
    progress: Callable[[str], None] | None = print,
    read_timeout_seconds: float = 900.0,
    retries: int = 4,
    retry_backoff_seconds: float = 5.0,
) -> dict[str, Any]:
    destination = Path(output_dir)
    destination.mkdir(parents=True, exist_ok=True)
    selected = _selected_archives(archive_numbers)
    retries = max(0, min(int(retries), 20))
    read_timeout_seconds = max(30.0, float(read_timeout_seconds))
    retry_backoff_seconds = max(0.0, float(retry_backoff_seconds))

    manifest_path = destination / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    except (OSError, json.JSONDecodeError):
        manifest = {}
    completed_archives = set(manifest.get("completed_archives") or [])
    archive_stats: list[dict[str, Any]] = []

    for archive_name in selected:
        final_candidates = destination / f"{archive_name}.candidates.jsonl"
        final_stats = destination / f"{archive_name}.stats.json"
        checkpoint_path = _checkpoint_path(destination, archive_name)
        partial = final_candidates.with_suffix(final_candidates.suffix + ".partial")

        if resume and archive_name in completed_archives and final_candidates.exists() and final_stats.exists():
            archive_stats.append(json.loads(final_stats.read_text(encoding="utf-8")))
            if progress is not None:
                progress(f"[{archive_name}] already completed; skipping")
            continue

        if not resume:
            partial.unlink(missing_ok=True)
            checkpoint_path.unlink(missing_ok=True)
        checkpoint = _read_checkpoint(checkpoint_path, archive_name) if resume else _read_checkpoint(Path("__missing__"), archive_name)
        expected_bytes = int(checkpoint.get("candidate_bytes") or 0)
        if partial.exists():
            with partial.open("r+b") as handle:
                if handle.seek(0, 2) < expected_bytes:
                    checkpoint = _read_checkpoint(Path("__missing__"), archive_name)
                    expected_bytes = 0
                handle.seek(expected_bytes)
                handle.truncate(expected_bytes)
        elif expected_bytes > 0:
            checkpoint = _read_checkpoint(Path("__missing__"), archive_name)
            expected_bytes = 0

        source_path = Path(local_dir) / archive_name if local_dir is not None else None
        if source_path is not None and not source_path.exists():
            raise FileNotFoundError(source_path)
        source_url = None if source_path is not None else zenodo_archive_url(archive_name)

        if progress is not None:
            resume_members = int(checkpoint.get("completed_json_members") or 0)
            suffix = f"; resume after {resume_members} completed JSON files" if resume_members else ""
            progress(
                f"[{archive_name}] starting {'local' if source_path else 'Zenodo stream'} scan{suffix}"
            )

        attempt = 0
        while True:
            try:
                with partial.open("r+b" if partial.exists() else "w+b") as output:
                    candidate_bytes = int(checkpoint.get("candidate_bytes") or 0)
                    output.seek(candidate_bytes)
                    output.truncate(candidate_bytes)
                    if source_path is not None:
                        with source_path.open("rb") as stream:
                            stats, completed_members, stopped_early = scan_tar_stream_resumable(
                                stream,
                                archive_name=archive_name,
                                output=output,
                                checkpoint_path=checkpoint_path,
                                checkpoint=checkpoint,
                                max_channels=max_channels,
                                progress=progress,
                            )
                    else:
                        request = Request(
                            source_url or "",
                            headers={"User-Agent": _USER_AGENT},
                            method="GET",
                        )
                        with urlopen(request, timeout=read_timeout_seconds) as stream:  # noqa: S310 - fixed Zenodo URL
                            stats, completed_members, stopped_early = scan_tar_stream_resumable(
                                stream,
                                archive_name=archive_name,
                                output=output,
                                checkpoint_path=checkpoint_path,
                                checkpoint=checkpoint,
                                max_channels=max_channels,
                                progress=progress,
                            )
                break
            except Exception as exc:
                if source_path is not None or attempt >= retries:
                    raise
                attempt += 1
                checkpoint = _read_checkpoint(checkpoint_path, archive_name)
                delay = retry_backoff_seconds * min(8, 2 ** (attempt - 1))
                if progress is not None:
                    progress(
                        f"[{archive_name}] stream interrupted: {type(exc).__name__}: {exc}; "
                        f"retry {attempt}/{retries} from JSON checkpoint after {delay:.1f}s"
                    )
                if delay > 0:
                    time.sleep(delay)

        if stopped_early:
            stats_payload = stats.as_dict()
            stats_payload["completed_at"] = utcnow_iso()
            stats_payload["source"] = str(source_path) if source_path else source_url
            stats_payload["partial"] = True
            archive_stats.append(stats_payload)
            continue

        partial.replace(final_candidates)
        checkpoint_path.unlink(missing_ok=True)
        stats_payload = stats.as_dict()
        stats_payload["completed_at"] = utcnow_iso()
        stats_payload["source"] = str(source_path) if source_path else source_url
        stats_payload["partial"] = False
        stats_payload["network_retries"] = attempt
        stats_payload["read_timeout_seconds"] = read_timeout_seconds if source_path is None else None
        final_stats.write_text(json.dumps(stats_payload, ensure_ascii=False, indent=2), encoding="utf-8")
        archive_stats.append(stats_payload)
        completed_archives.add(archive_name)
        manifest = {
            "version": 2,
            "record_id": ZENODO_RECORD_ID,
            "completed_archives": sorted(completed_archives),
            "updated_at": utcnow_iso(),
            "resumable_json_member_checkpoints": True,
        }
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    summary = build_outputs(destination, seed_limit=seed_limit)
    summary["archives"] = archive_stats
    summary["resumable_json_member_checkpoints"] = True
    (destination / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    return summary
