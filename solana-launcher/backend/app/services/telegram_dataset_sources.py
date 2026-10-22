"""Import public Telegram channel datasets into the existing collector registry.

The default remote source is a small, licensed channel-metadata snapshot. The 71 GB TGDataset
archive is intentionally not downloaded automatically; operators can point the local importer at
an already-downloaded copy. Dataset metadata is used to queue public channels for normal
relevance validation; message collection remains in TelegramPublicWebDiscoveryCollector.
"""

from __future__ import annotations

import csv
import io
import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx

from app.services.telegram_discovery_registry import import_dataset_channel_candidates
from app.services.telegram_parser import normalize_telegram_target

TGATLAS_DATASET_NAME = "tgatlas-telegram-public-channels-2026-W36"
TGATLAS_DATASET_URL = (
    "https://huggingface.co/datasets/starnikovoleg/telegram-public-channels-2026-W36"
)
TGATLAS_CHANNELS_CSV_URL = (
    "https://huggingface.co/datasets/starnikovoleg/telegram-public-channels-2026-W36/"
    "resolve/main/channels.csv"
)
TGATLAS_RECOMMENDATIONS_CSV_URL = (
    "https://huggingface.co/datasets/starnikovoleg/telegram-public-channels-2026-W36/"
    "resolve/main/recommendations.csv"
)
TGATLAS_LICENSE = "CC-BY-4.0"
SMUGCALLS_DATASET_NAME = "smugcalls-solana-memecoin-calls"
SMUGCALLS_DATASET_URL = "https://github.com/Smurfetc/solana-memecoin-calls-dataset"
SMUGCALLS_LICENSE = "CC0-1.0"
MAX_REMOTE_CSV_BYTES = 8 * 1024 * 1024
DEFAULT_TOPICS = {"crypto", "finance"}


def _as_int(value: Any) -> int | None:
    if isinstance(value, bool) or value is None or str(value).strip() == "":
        return None
    try:
        return max(0, min(int(float(str(value).replace(",", ""))), 2_147_483_647))
    except (TypeError, ValueError, OverflowError):
        return None


def _as_float(value: Any) -> float | None:
    if isinstance(value, bool) or value is None or str(value).strip() == "":
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return parsed if 0 <= parsed < 1_000_000 else None


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().casefold() in {"1", "true", "yes", "y"}


def _cell(row: dict[str, Any], *names: str) -> str:
    by_lower = {str(key).strip().casefold(): value for key, value in row.items()}
    for name in names:
        value = by_lower.get(name.casefold())
        if value is not None and str(value).strip():
            return str(value).strip()
    return ""


def parse_public_channel_snapshot(
    csv_text: str,
    *,
    allowed_topics: set[str] | None = None,
    max_channels: int = 1000,
) -> list[dict[str, Any]]:
    """Parse the tgAtlas CSV while keeping only configured topic categories."""
    topics = {
        topic.strip().casefold()
        for topic in (allowed_topics or DEFAULT_TOPICS)
        if topic.strip()
    }
    limit = max(0, min(int(max_channels), 20_000))
    if limit == 0:
        return []

    records: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in csv.DictReader(io.StringIO(csv_text)):
        username = normalize_telegram_target(_cell(row, "username", "channel", "telegram"))
        topic = _cell(row, "topic", "category").casefold()
        if not username or (topics and topic not in topics) or username in seen:
            continue
        seen.add(username)
        subscribers = _as_int(_cell(row, "subscribers", "n_subscribers", "participants"))
        recommended_by = _as_int(_cell(row, "recommended_by", "recommendation_count"))
        records.append(
            {
                "username": username,
                "title": _cell(row, "title", "name") or username,
                "topic": topic or "unknown",
                "tags": [topic] if topic else [],
                "participants": subscribers,
                "verified": _as_bool(_cell(row, "verified")),
                "posts_per_day": _as_float(_cell(row, "posts_per_day")),
                "recommended_by": recommended_by,
                "snapshot": _cell(row, "week", "measured_on"),
                "source_name": TGATLAS_DATASET_NAME,
                "source_url": TGATLAS_DATASET_URL,
                "license": TGATLAS_LICENSE,
                "attribution": "tgAtlas",
            }
        )
    records.sort(
        key=lambda row: (
            int(row.get("recommended_by") or 0),
            int(row.get("participants") or 0),
            str(row.get("username") or ""),
        ),
        reverse=True,
    )
    return records[:limit]


def parse_recommendation_edges(
    csv_text: str,
    *,
    relevant_usernames: set[str],
    existing_usernames: set[str],
    limit: int,
) -> list[dict[str, Any]]:
    """Add bounded graph neighbors of relevant channels as unverified candidates."""
    max_rows = max(0, min(int(limit), 20_000))
    if not max_rows or not relevant_usernames:
        return []

    records: list[dict[str, Any]] = []
    seen = set(existing_usernames)
    for row in csv.DictReader(io.StringIO(csv_text)):
        source = normalize_telegram_target(
            _cell(row, "source_username", "source_channel", "source", "from_username", "from")
        )
        target = normalize_telegram_target(
            _cell(
                row,
                "recommended_username",
                "recommended_channel",
                "recommended",
                "target_username",
                "target",
                "to_username",
                "to",
            )
        )
        if not source or source not in relevant_usernames or not target or target in seen:
            continue
        seen.add(target)
        records.append(
            {
                "username": target,
                "title": target,
                "topic": "crypto-recommendation",
                "tags": ["crypto", "recommendation-graph"],
                "recommended_from_dataset": source,
                "source_name": TGATLAS_DATASET_NAME,
                "source_url": TGATLAS_DATASET_URL,
                "license": TGATLAS_LICENSE,
            }
        )
        if len(records) >= max_rows:
            break
    return records


async def _download_csv(client: httpx.AsyncClient, url: str) -> str:
    response = await client.get(url)
    response.raise_for_status()
    if len(response.content) > MAX_REMOTE_CSV_BYTES:
        raise ValueError(f"Dataset CSV exceeds {MAX_REMOTE_CSV_BYTES} bytes: {url}")
    return response.content.decode("utf-8-sig")


async def sync_public_dataset_channels(sessionmaker, settings) -> dict[str, Any]:
    """Fetch configured public metadata sources and enqueue their channels idempotently."""
    topics_raw = str(getattr(settings, "telegram_dataset_sync_topics", "crypto,finance") or "")
    topics = {value.strip().casefold() for value in topics_raw.split(",") if value.strip()}
    max_channels = max(
        1,
        min(int(getattr(settings, "telegram_dataset_sync_max_channels", 1000) or 1000), 20_000),
    )
    timeout = max(
        2.0,
        min(float(getattr(settings, "telegram_public_web_timeout_seconds", 12.0)), 60.0),
    )
    records: list[dict[str, Any]] = [
        {
            "username": "SmugCalls",
            "title": "SmugCalls Solana Memecoin Calls",
            "topic": "solana-memecoin-calls",
            "tags": ["solana", "memecoin", "calls", "public-channel"],
            "source_name": SMUGCALLS_DATASET_NAME,
            "source_url": SMUGCALLS_DATASET_URL,
            "license": SMUGCALLS_LICENSE,
            "attribution": "SmugCalls / Smurfetc",
        }
    ]
    errors: list[dict[str, str]] = []
    snapshot_usernames: set[str] = set()

    try:
        async with httpx.AsyncClient(
            timeout=timeout,
            follow_redirects=True,
            headers={"User-Agent": "TelegramDatasetCollector/1.0 (+public dataset ingestion)"},
        ) as client:
            channels_csv = await _download_csv(client, TGATLAS_CHANNELS_CSV_URL)
            channel_budget = max(1, (max_channels * 4) // 5)
            channels = parse_public_channel_snapshot(
                channels_csv, allowed_topics=topics, max_channels=channel_budget
            )
            snapshot_usernames = {str(row["username"]) for row in channels}
            records.extend(channels[: max(0, max_channels - len(records))])
            remaining = max(0, max_channels - len(records))
            if remaining:
                try:
                    edges_csv = await _download_csv(client, TGATLAS_RECOMMENDATIONS_CSV_URL)
                    records.extend(
                        parse_recommendation_edges(
                            edges_csv,
                            relevant_usernames=snapshot_usernames,
                            existing_usernames={str(row["username"]) for row in records},
                            limit=remaining,
                        )
                    )
                except (httpx.HTTPError, ValueError, UnicodeDecodeError) as exc:
                    errors.append({"source": TGATLAS_DATASET_NAME, "error": str(exc)[:300]})
    except (httpx.HTTPError, ValueError, UnicodeDecodeError) as exc:
        errors.append({"source": TGATLAS_DATASET_NAME, "error": str(exc)[:300]})

    stats = await import_dataset_channel_candidates(
        sessionmaker,
        records,
        source_name="public-telegram-datasets",
        source_url="",
        source_license="",
    )
    by_source: dict[str, int] = {}
    for row in records:
        source = str(row.get("source_name") or "public-telegram-datasets")
        by_source[source] = by_source.get(source, 0) + 1
    return {
        "enabled": True,
        "sources": by_source,
        "records": stats,
        "errors": errors,
        "topics": sorted(topics),
        "max_channels": max_channels,
    }


def _local_row(
    row: dict[str, Any],
    *,
    source_name: str,
    topic_by_id: dict[str, str] | None = None,
    language_by_id: dict[str, str] | None = None,
) -> dict[str, Any] | None:
    username = normalize_telegram_target(str(row.get("username") or row.get("url") or ""))
    if not username:
        return None
    channel_id = str(row.get("channel_id") or row.get("telegram_channel_id") or "").strip()
    topic = str(
        row.get("topic")
        or row.get("category")
        or (topic_by_id or {}).get(channel_id, "")
    ).strip().casefold()
    language = str((language_by_id or {}).get(channel_id, "")).strip().casefold()
    raw_tags = row.get("tags")
    tags: list[str] = []
    if isinstance(raw_tags, list):
        tags.extend(str(tag).strip() for tag in raw_tags if str(tag).strip())
    if topic:
        tags.append(topic)
    if language:
        tags.append(f"lang:{language}")
    return {
        "username": username,
        "title": str(row.get("title") or username)[:255],
        "about": str(row.get("description") or row.get("about") or "")[:4000],
        "participants": row.get("n_subscribers", row.get("subscribers", row.get("participants"))),
        "channel_id": channel_id or None,
        "creation_date": row.get("creation_date", row.get("created")),
        "language": language or None,
        "verified": row.get("verified"),
        "scam": row.get("scam", False),
        "topic": topic,
        "tags": tags,
        "source_name": source_name,
        "source_url": str(row.get("source_url") or "")[:500],
        "license": str(row.get("license") or "")[:100],
        "attribution": str(row.get("attribution") or "")[:150],
        "snapshot": str(row.get("snapshot") or row.get("week") or "")[:40],
    }


def _load_local_channel_labels(root: Path) -> tuple[dict[str, str], dict[str, str]]:
    """Load optional TGDataset topic/language maps without treating label lists as seeds."""
    search_root = root if root.is_dir() else root.parent
    topic_by_id: dict[str, str] = {}
    language_by_id: dict[str, str] = {}
    if not search_root.exists():
        return topic_by_id, language_by_id

    for csv_path in search_root.rglob("*.csv"):
        name = csv_path.name.casefold()
        if name not in {"ch_to_topic_mapping.csv", "channel_to_language_mapping.csv"}:
            continue
        target = topic_by_id if name == "ch_to_topic_mapping.csv" else language_by_id
        try:
            with csv_path.open("r", encoding="utf-8-sig", newline="") as source:
                for row in csv.DictReader(source):
                    channel_id = _cell(row, "ch_id", "channel_id", "id")
                    label = _cell(row, "topic", "language", "lang")
                    if channel_id and label:
                        target[channel_id.strip()] = label.strip().casefold()
        except OSError:
            continue
    return topic_by_id, language_by_id


def _iter_large_tgdataset_json(path: Path) -> Iterator[dict[str, Any]]:
    """Stream only channel-level metadata from TGDataset's channel_id -> channel JSON map."""
    try:
        import ijson
    except ImportError as exc:  # pragma: no cover - declared production dependency
        raise RuntimeError(
            "Large TGDataset files require ijson; install backend requirements"
        ) from exc

    with path.open("rb") as source:
        current_id: str | None = None
        current: dict[str, Any] = {}
        yielded = False
        for prefix, event, value in ijson.parse(source):
            if prefix == "" and event == "map_key":
                current_id = str(value)
                current = {"channel_id": current_id}
                yielded = False
            elif (
                current_id is not None
                and prefix == f"{current_id}.text_messages"
                and event == "start_map"
                and not yielded
            ):
                # TGDataset puts channel metadata before its potentially huge message map.
                yield current
                yielded = True
            elif current_id is not None and prefix in {
                f"{current_id}.username",
                f"{current_id}.title",
                f"{current_id}.description",
                f"{current_id}.scam",
                f"{current_id}.verified",
                f"{current_id}.n_subscribers",
                f"{current_id}.creation_date",
            } and event in {"string", "number", "boolean", "null"}:
                current[prefix.rsplit(".", 1)[-1]] = value
            elif current_id is not None and prefix == current_id and event == "end_map":
                if not yielded:
                    yield current
                current_id = None
                current = {}
                yielded = False


def iter_local_dataset_channels(
    path: str | Path,
    *,
    limit: int = 1000,
    source_name: str | None = None,
    topics: set[str] | None = None,
) -> Iterator[dict[str, Any]]:
    """Stream public channel metadata from CSV/JSON files or a local TGDataset directory.

    The default limit is bounded. Pass limit=0 to scan every local record. Nested historical
    message bodies are deliberately not loaded from TGDataset; selected channels are then
    collected through the existing live collector, while archive messages use tgparser_import.
    """
    root = Path(path).expanduser()
    if not root.exists():
        raise FileNotFoundError(f"Local dataset path does not exist: {root}")
    maximum = max(0, int(limit))
    count = 0
    topic_by_id, language_by_id = _load_local_channel_labels(root)
    requested_topics = {value.strip().casefold() for value in topics or set() if value.strip()}
    explicit_all_topics = bool(requested_topics & {"all", "*"})
    topic_filter = requested_topics - {"all", "*"}
    if (
        not topic_filter
        and not explicit_all_topics
        and source_name == "tgdataset-local"
        and topic_by_id
    ):
        topic_filter = {"crypto"}
    files = [root] if root.is_file() else sorted([*root.rglob("*.csv"), *root.rglob("*.json")])
    for file_path in files:
        if file_path.suffix.casefold() == ".csv":
            if file_path.name.casefold() in {
                "ch_to_topic_mapping.csv",
                "channel_to_language_mapping.csv",
            }:
                continue
            if "labeled_data" in {part.casefold() for part in file_path.parts}:
                continue
            with file_path.open("r", encoding="utf-8-sig", newline="") as source:
                for row in csv.DictReader(source):
                    normalized = _local_row(
                        row,
                        source_name=source_name or f"local:{file_path.name}",
                        topic_by_id=topic_by_id,
                        language_by_id=language_by_id,
                    )
                    if normalized and (
                        not topic_filter or normalized.get("topic") in topic_filter
                    ):
                        yield normalized
                        count += 1
                    if maximum and count >= maximum:
                        return
            continue

        if file_path.suffix.casefold() != ".json":
            continue
        if file_path.stat().st_size <= 20 * 1024 * 1024:
            try:
                payload = json.loads(file_path.read_text(encoding="utf-8-sig"))
            except (OSError, json.JSONDecodeError):
                continue
            if isinstance(payload, dict):
                rows = payload.get("channels", payload.get("rows"))
                if not isinstance(rows, list):
                    rows = [
                        {"channel_id": key, **value}
                        for key, value in payload.items()
                        if isinstance(value, dict)
                    ]
            elif isinstance(payload, list):
                rows = payload
            else:
                rows = []
            for row in rows:
                if not isinstance(row, dict):
                    continue
                normalized = _local_row(
                    row,
                    source_name=source_name or f"local:{file_path.name}",
                    topic_by_id=topic_by_id,
                    language_by_id=language_by_id,
                )
                if normalized and (
                    not topic_filter or normalized.get("topic") in topic_filter
                ):
                    yield normalized
                    count += 1
                if maximum and count >= maximum:
                    return
        else:
            for row in _iter_large_tgdataset_json(file_path):
                normalized = _local_row(
                    row,
                    source_name=source_name or "tgdataset-local",
                    topic_by_id=topic_by_id,
                    language_by_id=language_by_id,
                )
                if normalized and (
                    not topic_filter or normalized.get("topic") in topic_filter
                ):
                    yield normalized
                    count += 1
                if maximum and count >= maximum:
                    return
