from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from app.services.teragram_scanner import (
    TERAGRAM_FULL_DOI,
    TERAGRAM_PREVIEW_LATEST_DOI,
    TERAGRAM_PREVIEW_RECORD_ID,
    TERAGRAM_PREVIEW_VERSION,
)

_BACKEND_ROOT = Path(__file__).resolve().parents[2]
_DEFAULT_OUTPUT_DIR = "data/teragram"
_ALLOWED_CLASSIFICATIONS = {
    "crypto",
    "memecoin",
    "solana",
    "caller",
    "memecoin_calls",
    "solana_memecoin",
}


def _configured_output_label() -> str:
    configured = (os.getenv("TG_TERAGRAM_OUTPUT_DIR") or _DEFAULT_OUTPUT_DIR).strip()
    return configured or _DEFAULT_OUTPUT_DIR


def teragram_output_dir() -> Path:
    path = Path(_configured_output_label()).expanduser()
    if not path.is_absolute():
        path = _BACKEND_ROOT / path
    return path.resolve()


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _safe_int(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _seed_rows(output: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    payload = _read_json(output / "telegram_seed_database.json")
    if isinstance(payload, dict):
        rows = payload.get("channels")
        result = [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []
        return result, payload
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)], {}
    return [], {}


def get_teragram_invite_status(*, active_seed_database: str = "") -> dict[str, Any]:
    output = teragram_output_dir()
    summary = _read_json(output / "summary.json")
    summary = summary if isinstance(summary, dict) else {}
    rows, seed_document = _seed_rows(output)
    generated_at = summary.get("generated_at") or seed_document.get("generated_at")
    categories = summary.get("categories") if isinstance(summary.get("categories"), dict) else {}
    output_label = _configured_output_label().rstrip("/\\")
    expected_seed = f"{output_label}/telegram_seed_database.json"
    normalized_active = (active_seed_database or "").replace("\\", "/").strip()
    normalized_expected = expected_seed.replace("\\", "/").strip()
    ready = bool(rows)

    return {
        "ready": ready,
        "has_summary": bool(summary),
        "generated_at": generated_at,
        "signal_source": summary.get("signal_source"),
        "chats_total": _safe_int(summary.get("chats_total")),
        "prefiltered_chats": _safe_int(summary.get("prefiltered_chats")),
        "candidate_channels": _safe_int(summary.get("candidate_channels")),
        "seed_channels": len(rows),
        "signal_rows_exactly_scored": _safe_int(summary.get("signal_rows_exactly_scored")),
        "categories": {str(key): _safe_int(value) for key, value in categories.items()},
        "output_dir": _configured_output_label(),
        "seed_database": expected_seed,
        "active_for_public_discovery": bool(
            normalized_active and normalized_active == normalized_expected
        ),
        "source": {
            "name": "TeraGram",
            "preview_record_id": TERAGRAM_PREVIEW_RECORD_ID,
            "preview_version": TERAGRAM_PREVIEW_VERSION,
            "latest_preview_doi": TERAGRAM_PREVIEW_LATEST_DOI,
            "full_dataset_doi": TERAGRAM_FULL_DOI,
        },
        "message": (
            "TeraGram seed database is ready for TG Invite."
            if ready
            else "Run the TeraGram filter first; no seed database is available yet."
        ),
    }


def list_teragram_invite_channels(
    *,
    limit: int = 250,
    classification: str | None = None,
) -> tuple[list[dict[str, Any]], int]:
    if limit < 1:
        raise ValueError("limit must be positive")
    normalized_class = (classification or "").strip().lower() or None
    if normalized_class and normalized_class not in _ALLOWED_CLASSIFICATIONS:
        raise ValueError("unsupported TeraGram classification")

    rows, _ = _seed_rows(teragram_output_dir())
    result: list[dict[str, Any]] = []
    total = 0
    seen: set[str] = set()
    for row in rows:
        username = str(row.get("username") or "").strip().lstrip("@")
        if not username:
            continue
        classes = [str(value) for value in row.get("classifications", []) if value]
        if normalized_class and normalized_class not in classes:
            continue
        key = username.lower()
        if key in seen:
            continue
        seen.add(key)
        total += 1
        if len(result) >= limit:
            continue
        result.append(
            {
                "username": username,
                "seed_score": float(row.get("seed_score") or 0.0),
                "scores": row.get("scores") if isinstance(row.get("scores"), dict) else {},
                "classifications": classes,
                "n_subscribers": _safe_int(row.get("n_subscribers")),
                "channel_id": str(row.get("channel_id") or ""),
                "teragram_chat_id": str(row.get("teragram_chat_id") or ""),
            }
        )
    return result, total
