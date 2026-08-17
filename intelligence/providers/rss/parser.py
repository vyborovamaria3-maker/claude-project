"""Small dependency-free RSS 2.0 and Atom parser."""

from __future__ import annotations

import email.utils
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timezone

from intelligence.errors.exceptions import NormalizationError


@dataclass(frozen=True, slots=True)
class FeedEntry:
    title: str
    link: str | None
    summary: str
    published_at: datetime | None
    entry_id: str | None


def parse_feed(payload: bytes, *, max_items: int = 50) -> list[FeedEntry]:
    if max_items < 1:
        raise ValueError("max_items must be > 0")

    lowered = payload[:8192].lower()
    if b"<!doctype" in lowered or b"<!entity" in lowered:
        raise NormalizationError("RSS/Atom feed contains forbidden XML declarations")

    try:
        root = ET.fromstring(payload)
    except ET.ParseError as exc:
        raise NormalizationError("RSS/Atom feed is not valid XML") from exc

    tag = _local_name(root.tag)
    if tag == "rss":
        entries = _parse_rss(root)
    elif tag == "feed":
        entries = _parse_atom(root)
    else:
        raise NormalizationError("Unsupported feed format")
    return entries[:max_items]


def _parse_rss(root: ET.Element) -> list[FeedEntry]:
    channel = next((child for child in root if _local_name(child.tag) == "channel"), None)
    if channel is None:
        raise NormalizationError("RSS feed has no channel")

    result: list[FeedEntry] = []
    for item in channel:
        if _local_name(item.tag) != "item":
            continue
        title = _child_text(item, "title") or "Untitled"
        link = _child_text(item, "link")
        summary = _child_text(item, "description") or ""
        guid = _child_text(item, "guid")
        published_at = _parse_rfc2822(_child_text(item, "pubDate"))
        result.append(FeedEntry(title, link, summary, published_at, guid))
    return result


def _parse_atom(root: ET.Element) -> list[FeedEntry]:
    result: list[FeedEntry] = []
    for item in root:
        if _local_name(item.tag) != "entry":
            continue
        title = _child_text(item, "title") or "Untitled"
        summary = _child_text(item, "summary") or _child_text(item, "content") or ""
        entry_id = _child_text(item, "id")
        published = _child_text(item, "published") or _child_text(item, "updated")
        link = None
        for child in item:
            if _local_name(child.tag) == "link":
                href = child.attrib.get("href")
                rel = child.attrib.get("rel", "alternate")
                if href and rel in {"alternate", ""}:
                    link = href
                    break
        result.append(FeedEntry(title, link, summary, _parse_iso8601(published), entry_id))
    return result


def _child_text(element: ET.Element, name: str) -> str | None:
    target = name.lower()
    for child in element:
        if _local_name(child.tag) == target:
            text = "".join(child.itertext()).strip()
            return text or None
    return None


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def _parse_rfc2822(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _parse_iso8601(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)
