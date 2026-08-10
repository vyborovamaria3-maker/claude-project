"""Normalize Jina Reader content into intelligence documents."""

from __future__ import annotations

from datetime import datetime, timezone
from urllib.parse import urlsplit
from uuid import uuid4

from intelligence.core.hashing import build_document_hash
from intelligence.core.models import IntelligenceDocument
from intelligence.security.sanitizer import sanitize_text


def web_content_to_document(url: str, content: str) -> IntelligenceDocument:
    sanitized = sanitize_text(content).strip()
    hostname = (urlsplit(url).hostname or "unknown").lower()
    document = IntelligenceDocument(
        id=str(uuid4()),
        source="web",
        provider="jina-reader",
        content=sanitized,
        collected_at=datetime.now(timezone.utc),
        url=url,
        author=hostname,
        entities=["webpage", hostname],
        metrics={
            "characters": len(sanitized),
            "lines": len(sanitized.splitlines()),
        },
    )
    document.raw_hash = build_document_hash(document)
    return document
