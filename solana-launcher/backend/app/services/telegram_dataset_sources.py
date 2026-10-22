from __future__ import annotations

import csv
import hashlib
import json
import re
from collections.abc import Iterable, Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.social_intelligence import TelegramChannel
from app.services.telegram_parser import normalize_telegram_target

_BACKEND_ROOT = Path(__file__).resolve().parents[2]
_SUPPORTED_SUFFIXES = {".csv", ".json", ".jsonl", ".ndjson"}
_USERNAME_RE = re.compile(r"^[a-z0-9_]{5,32}$", re.IGNORECASE)
_RESERVED_TARGETS = {
    "addstickers",
    "confirmphone",
    "contact",
    "iv",
    "joinchat",
    "login",
    "proxy",
    "setlanguage",
    "share",
    "socks",
}
_BATCH_SIZE = 500
DATASET_REGISTRY_SOURCES = frozenset({"tgdataset", "teragram", "custom"})
_MISSING = object()


def utcnow() -> datetime:
    return datetime.now(UTC)


def _public_channel_id(username: str) -> int:
    digest = hashlib.sha256(f"telegram-public:{username.lower()}".encode()).digest()
    value = int.from_bytes(digest[:8], "big") & ((1 << 63) - 1)
    return -(value or 1)


def _resolve_path(raw: str | Path) -> Path:
    path = Path(raw).expanduser()
    if not path.is_absolute():
        path = _BACKEND_ROOT / path
    return path.resolve()


def _configured_paths(settings: Any) -> list[Path]:
    raw = str(getattr(settings, "telegram_public_web_dataset_paths", "") or "")
    values = [item.strip() for item in re.split(r"[;,\n]", raw) if item.strip()]
    return [_resolve_path(value) for value in values]


def discover_dataset_files(settings: Any) -> list[Path]:
    """Find generated TGDataset/TeraGram candidates plus explicitly configured datasets.

    Historical archives themselves are deliberately not downloaded here. The dataset scanners
    remain explicit CLI jobs; this function consumes their compact candidate outputs.
    """

    found: dict[str, Path] = {}

    def add_file(path: Path) -> None:
        try:
            resolved = path.resolve()
            if resolved.is_file() and resolved.suffix.lower() in _SUPPORTED_SUFFIXES:
                found[str(resolved)] = resolved
        except OSError:
            return

    data_root = _BACKEND_ROOT / "data"
    tgdataset_root = data_root / "tgdataset"
    teragram_roots = {
        (data_root / "teragram").resolve(),
        _resolve_path(
            str(
                getattr(settings, "telegram_teragram_output_dir", "data/teragram")
                or "data/teragram"
            )
        ),
    }
    custom_root = data_root / "telegram-datasets"

    if tgdataset_root.is_dir():
        for path in sorted(tgdataset_root.glob("TGDataset_*.candidates.jsonl")):
            add_file(path)
        add_file(tgdataset_root / "telegram_seed_database.json")
    for teragram_root in sorted(teragram_roots):
        if teragram_root.is_dir():
            add_file(teragram_root / "teragram_candidates.jsonl")
            add_file(teragram_root / "telegram_seed_database.json")
    if custom_root.is_dir():
        for path in sorted(custom_root.rglob("*")):
            add_file(path)

    configured_seed = str(getattr(settings, "telegram_public_web_seed_database", "") or "").strip()
    if configured_seed:
        add_file(_resolve_path(configured_seed))

    for configured in _configured_paths(settings):
        if configured.is_dir():
            for path in sorted(configured.rglob("*")):
                add_file(path)
        else:
            add_file(configured)

    return [found[key] for key in sorted(found)]


def dataset_manifest(settings: Any) -> tuple[tuple[str, int, int], ...]:
    """Return a cheap change signature so the background worker does not rescan unchanged files."""

    signature: list[tuple[str, int, int]] = []
    for path in discover_dataset_files(settings):
        try:
            stat = path.stat()
        except OSError:
            continue
        signature.append((str(path), int(stat.st_size), int(stat.st_mtime_ns)))
    return tuple(signature)


def _source_id(path: Path, settings: Any) -> str:
    lowered = "/".join(part.lower() for part in path.parts)
    if "tgdataset" in lowered:
        return "tgdataset"
    if "teragram" in lowered:
        return "teragram"
    configured_root = _resolve_path(
        str(getattr(settings, "telegram_teragram_output_dir", "data/teragram") or "data/teragram")
    )
    try:
        if path.resolve().is_relative_to(configured_root):
            return "teragram"
    except OSError:
        pass
    return "custom"


def _source_file_label(path: Path) -> str:
    try:
        return path.resolve().relative_to(_BACKEND_ROOT).as_posix()
    except ValueError:
        return "/".join(path.parts[-2:])


def _iter_json_records(path: Path) -> Iterator[dict[str, Any]]:
    if path.suffix.lower() in {".jsonl", ".ndjson"}:
        with path.open("r", encoding="utf-8-sig") as handle:
            for line in handle:
                if not line.strip():
                    continue
                try:
                    value = json.loads(line)
                except json.JSONDecodeError:
                    continue
                yield from _records_from_value(value)
        return

    ijson: Any = None
    try:
        import ijson as ijson_module
    except ImportError:  # pragma: no cover - backend dependencies include ijson
        pass
    else:
        ijson = ijson_module

    if ijson is not None:
        with path.open("rb") as handle:
            for prefix in (
                "channels.item", "data.channels.item", "data.item", "results.item", "item"
            ):
                handle.seek(0)
                rows = ijson.items(handle, prefix)
                first = next(rows, _MISSING)
                if first is _MISSING:
                    continue
                yield from _records_from_value(first)
                for row in rows:
                    yield from _records_from_value(row)
                return

    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return
    yield from _records_from_value(payload)


def _records_from_value(value: Any) -> Iterator[dict[str, Any]]:
    if isinstance(value, dict):
        for key in ("channels", "results", "data"):
            nested = value.get(key)
            if isinstance(nested, list):
                for row in nested:
                    if isinstance(row, dict):
                        yield row
                return
        yield value
    elif isinstance(value, list):
        for row in value:
            if isinstance(row, dict):
                yield row


def _iter_records(path: Path) -> Iterator[dict[str, Any]]:
    suffix = path.suffix.lower()
    if suffix == ".csv":
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            for row in csv.DictReader(handle):
                if row:
                    yield dict(row)
        return
    if suffix in {".json", ".jsonl", ".ndjson"}:
        yield from _iter_json_records(path)


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value or "").strip().lower() in {"1", "true", "yes", "y", "scam"}


def _safe_int(value: Any) -> int:
    try:
        return max(0, int(float(value or 0)))
    except (TypeError, ValueError, OverflowError):
        return 0


def _safe_float(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return 0.0
    if number != number or number in {float("inf"), float("-inf")}:  # NaN/inf guard
        return 0.0
    return max(0.0, min(100.0, number))


def _string_list(value: Any) -> list[str]:
    if isinstance(value, list | tuple | set):
        items = value
    elif isinstance(value, str):
        text = value.strip()
        if text.startswith("["):
            try:
                decoded = json.loads(text)
            except json.JSONDecodeError:
                decoded = None
            if isinstance(decoded, list):
                items = decoded
            else:
                items = re.split(r"[,;|]", value)
        else:
            items = re.split(r"[,;|]", value)
    else:
        items = []
    return list(
        dict.fromkeys(
            str(item).strip().lower()
            for item in items
            if item is not None and str(item).strip()
        )
    )


def _normalize_candidate(
    row: dict[str, Any], *, source: str, source_file: str
) -> dict[str, Any] | None:
    if _truthy(row.get("scam", row.get("is_scam", False))):
        return None

    raw_target = (
        row.get("username")
        or row.get("telegram_username")
        or row.get("channel_username")
        or row.get("tg_username")
        or row.get("channel_url")
        or row.get("telegram_url")
        or row.get("telegram_link")
        or row.get("url")
        or row.get("link")
        or row.get("channel")
    )
    username = normalize_telegram_target(str(raw_target or ""))
    if not _USERNAME_RE.fullmatch(username) or username in _RESERVED_TARGETS:
        return None

    classes = _string_list(
        row.get("classifications")
        or row.get("categories")
        or row.get("category")
        or row.get("tags")
    )
    title = str(
        row.get("title") or row.get("channel_name") or row.get("name") or username
    ).strip()[:255] or username
    description = str(row.get("description") or row.get("about") or "").strip()[:4000]
    scores = row.get("scores") if isinstance(row.get("scores"), dict) else {}
    seed_score = _safe_float(row.get("seed_score") or row.get("score"))
    subscribers = _safe_int(
        row.get("n_subscribers")
        or row.get("subscribers")
        or row.get("participants")
        or row.get("member_count")
    )
    return {
        "username": username,
        "title": title,
        "description": description,
        "seed_score": seed_score,
        "classifications": classes,
        "scores": scores,
        "n_subscribers": subscribers,
        "verified": _truthy(row.get("verified", False)),
        "source": source,
        "source_file": source_file,
    }


def _candidate_batches(
    settings: Any, paths: Iterable[Path], stats: dict[str, int]
) -> Iterator[list[dict[str, Any]]]:
    batch: list[dict[str, Any]] = []
    for path in paths:
        source = _source_id(path, settings)
        stats["files"] += 1
        for raw in _iter_records(path):
            stats["records_read"] += 1
            candidate = _normalize_candidate(
                raw, source=source, source_file=_source_file_label(path)
            )
            if candidate is None:
                stats["records_skipped"] += 1
                continue
            batch.append(candidate)
            if len(batch) >= _BATCH_SIZE:
                yield batch
                batch = []
    if batch:
        yield batch


def _evidence(candidate: dict[str, Any]) -> dict[str, Any]:
    return {
        "file": candidate["source_file"],
        "seed_score": candidate["seed_score"],
        "classifications": candidate["classifications"],
        "scores": candidate["scores"],
        "n_subscribers": candidate["n_subscribers"],
        "verified": candidate["verified"],
        "title": candidate["title"],
    }


def _entry_changed(old: Any, evidence: dict[str, Any]) -> bool:
    if not isinstance(old, dict):
        return True
    return any(old.get(key) != value for key, value in evidence.items())


async def import_dataset_candidates(
    sessionmaker: async_sessionmaker[AsyncSession],
    settings: Any,
    *,
    paths: Iterable[Path] | None = None,
) -> dict[str, Any]:
    """Upsert public dataset candidates into the shared Telegram channel/refresh queue.

    Only public usernames are imported. Historical data is stored as provenance and never treated
    as proof that a channel is currently available or relevant; every candidate remains due for
    live validation by the existing collector.
    """

    selected_paths = list(paths) if paths is not None else discover_dataset_files(settings)
    stats: dict[str, int] = {
        "files": 0,
        "records_read": 0,
        "records_skipped": 0,
        "inserted": 0,
        "updated": 0,
        "unchanged": 0,
    }
    now = utcnow()
    now_iso = now.isoformat()

    async with sessionmaker() as session:
        for batch in _candidate_batches(settings, selected_paths, stats):
            usernames = sorted({str(row["username"]) for row in batch})
            existing_rows = list(
                (
                    await session.execute(
                        select(TelegramChannel).where(
                            func.lower(TelegramChannel.username).in_(usernames)
                        )
                    )
                )
                .scalars()
                .all()
            )
            by_username = {
                str(row.username).lower(): row for row in existing_rows if row.username
            }

            for candidate in batch:
                username = str(candidate["username"])
                channel = by_username.get(username)
                is_new = channel is None
                if channel is None:
                    channel = TelegramChannel(
                        telegram_id=_public_channel_id(username),
                        username=username,
                        title=candidate["title"],
                        entity_type="channel",
                        participants=candidate["n_subscribers"],
                        about=candidate["description"],
                        is_active=True,
                        first_seen_at=now,
                        last_seen_at=now,
                        last_scanned_at=None,
                        meta={},
                    )
                    session.add(channel)
                    by_username[username] = channel
                    stats["inserted"] += 1

                old_meta = dict(channel.meta) if isinstance(channel.meta, dict) else {}
                dataset_meta = old_meta.get("dataset_import")
                dataset_meta = dict(dataset_meta) if isinstance(dataset_meta, dict) else {}
                sources = dataset_meta.get("sources")
                sources = dict(sources) if isinstance(sources, dict) else {}
                source_key = f"{candidate['source']}:{candidate['source_file']}"
                evidence = _evidence(candidate)
                old_source = sources.get(source_key)
                changed = _entry_changed(old_source, evidence)
                if changed:
                    sources[source_key] = {**evidence, "imported_at": now_iso}
                elif isinstance(old_source, dict):
                    sources[source_key] = old_source

                classifications = sorted(
                    {
                        label
                        for source_row in sources.values()
                        if isinstance(source_row, dict)
                        for label in _string_list(source_row.get("classifications"))
                    }
                )
                seed_scores = [
                    _safe_float(source_row.get("seed_score"))
                    for source_row in sources.values()
                    if isinstance(source_row, dict)
                ]
                dataset_meta = {
                    **dataset_meta,
                    "sources": sources,
                    "classifications": classifications,
                    "seed_score": max(seed_scores, default=0.0),
                    "last_imported_at": now_iso,
                }

                registry_value = old_meta.get("discovery_registry")
                registry = dict(registry_value) if isinstance(registry_value, dict) else {}
                if (
                    not registry.get("source")
                    or registry.get("source") in {"registry", "candidate"}
                ):
                    registry["source"] = candidate["source"]
                if is_new or changed or not registry.get("next_check_at"):
                    registry.update(
                        {
                            "state": "candidate",
                            "discovered_from": registry.get("discovered_from"),
                            "depth": int(registry.get("depth") or 0),
                            "relevance_score": max(
                                _safe_float(registry.get("relevance_score")),
                                candidate["seed_score"],
                            ),
                            "failure_count": 0,
                            "next_check_at": now_iso,
                            "last_error": None,
                        }
                    )

                channel.meta = {
                    **old_meta,
                    "public_web": True,
                    "dataset_import": dataset_meta,
                    "discovery_registry": registry,
                }
                if candidate["description"] and not channel.about:
                    channel.about = candidate["description"]
                if (not channel.title or channel.title == username) and candidate["title"]:
                    channel.title = candidate["title"]
                channel.participants = max(
                    _safe_int(channel.participants), candidate["n_subscribers"]
                )
                channel.is_active = True
                if not is_new and changed:
                    stats["updated"] += 1
                elif not is_new:
                    stats["unchanged"] += 1

            await session.commit()

    stats["source_files_count"] = len(selected_paths)
    return {
        "enabled": bool(getattr(settings, "telegram_dataset_import_enabled", True)),
        **stats,
        "source_files": [path.name for path in selected_paths],
        "imported_at": now_iso,
    }
