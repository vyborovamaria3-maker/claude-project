"""Sanitization helpers before intelligence data persistence."""

from __future__ import annotations

import re
from typing import Any


_SECRET_PATTERNS = (
    re.compile(r"(?i)(password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+"),
    re.compile(r"(?i)(private[_-]?key|seed[_ -]?phrase|cookie)\s*[:=]\s*[^\s,;]+"),
)


_REDACTION = "[REDACTED]"


def sanitize_text(value: str) -> str:
    """Remove common credential patterns from arbitrary text."""
    result = value
    for pattern in _SECRET_PATTERNS:
        result = pattern.sub(lambda m: m.group(1) + "=" + _REDACTION, result)
    return result


def sanitize_payload(payload: Any) -> Any:
    """Recursively sanitize strings in collected provider payloads."""
    if isinstance(payload, str):
        return sanitize_text(payload)
    if isinstance(payload, list):
        return [sanitize_payload(item) for item in payload]
    if isinstance(payload, dict):
        return {key: sanitize_payload(value) for key, value in payload.items()}
    return payload
