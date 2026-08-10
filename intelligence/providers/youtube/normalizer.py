"""Normalize yt-dlp metadata and transcript into intelligence documents."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from intelligence.core.hashing import build_document_hash
from intelligence.core.models import IntelligenceDocument
from intelligence.errors.exceptions import NormalizationError
from intelligence.security.sanitizer import sanitize_text


def youtube_to_document(metadata: dict[str, Any], transcript: str | None = None) -> IntelligenceDocument:
    video_id = _required_text(metadata, "id")
    title = sanitize_text(_required_text(metadata, "title")).strip()
    webpage_url = _required_text(metadata, "webpage_url")
    channel = sanitize_text(str(metadata.get("channel") or metadata.get("uploader") or "unknown")).strip()
    description = sanitize_text(str(metadata.get("description") or "")).strip()
    clean_transcript = sanitize_text(transcript or "").strip()

    sections = [f"Title: {title}"]
    if description:
        sections.append(f"Description:\n{description}")
    if clean_transcript:
        sections.append(f"Transcript:\n{clean_transcript}")
    content = "\n\n".join(sections).strip()
    if not content:
        raise NormalizationError("YouTube evidence is empty")

    timestamp = _published_at(metadata)
    metrics = {
        "video_id": video_id,
        "duration_seconds": _safe_int(metadata.get("duration")),
        "view_count": _safe_int(metadata.get("view_count")),
        "like_count": _safe_int(metadata.get("like_count")),
        "comment_count": _safe_int(metadata.get("comment_count")),
        "channel_id": sanitize_text(str(metadata.get("channel_id") or metadata.get("uploader_id") or "")),
        "has_transcript": bool(clean_transcript),
        "transcript_characters": len(clean_transcript),
    }
    document = IntelligenceDocument(
        id=str(uuid4()),
        source="youtube",
        provider="yt-dlp",
        content=content,
        collected_at=datetime.now(timezone.utc),
        url=webpage_url,
        author=channel or "unknown",
        published_at=timestamp,
        entities=["youtube_video", video_id, channel or "unknown"],
        metrics=metrics,
    )
    document.raw_hash = build_document_hash(document)
    return document


def _required_text(payload: dict[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise NormalizationError(f"YouTube metadata is missing {key}")
    return value.strip()


def _safe_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        result = int(value)
    except (TypeError, ValueError):
        return None
    return max(0, result)


def _published_at(payload: dict[str, Any]) -> datetime | None:
    timestamp = payload.get("timestamp")
    if timestamp is not None:
        try:
            return datetime.fromtimestamp(float(timestamp), tz=timezone.utc)
        except (TypeError, ValueError, OSError, OverflowError):
            pass

    upload_date = payload.get("upload_date")
    if isinstance(upload_date, str) and len(upload_date) == 8 and upload_date.isdigit():
        try:
            return datetime.strptime(upload_date, "%Y%m%d").replace(tzinfo=timezone.utc)
        except ValueError:
            return None
    return None
