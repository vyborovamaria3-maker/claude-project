"""Deterministic hashes for normalized intelligence evidence."""

from __future__ import annotations

import hashlib
import json

from intelligence.core.models import IntelligenceDocument


def build_document_hash(document: IntelligenceDocument) -> str:
    """Return a stable SHA-256 fingerprint without timestamps or credentials."""
    payload = {
        "source": document.source.strip().lower(),
        "url": (document.url or "").strip(),
        "author": (document.author or "").strip(),
        "content": document.content.strip(),
    }
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()
