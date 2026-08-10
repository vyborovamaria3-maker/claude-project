"""Sanitization helpers before intelligence data persistence."""

from __future__ import annotations

import re
from typing import Any


_REDACTION = "[REDACTED]"
_SENSITIVE_KEY_RE = re.compile(
    r"(?ix)^(?:password|passwd|secret|token|api[ _-]?key|apikey|authorization|"
    r"private[ _-]?key|seed[ _-]?phrase|cookie)$"
)
_SECRET_PATTERNS = (
    re.compile(
        r"(?ix)\b(password|passwd|secret|token|api[ _-]?key|apikey|private[ _-]?key|seed[ _-]?phrase|cookie)"
        r"\s*[:=]\s*([^\s,;]+)"
    ),
    re.compile(r"(?ix)\b(authorization)\s*[:=]?\s*(?:bearer\s+|basic\s+)?([^\s,;]+)"),
)


def sanitize_text(value: str) -> str:
    """Remove common credential patterns from arbitrary text."""
    result = value
    for pattern in _SECRET_PATTERNS:
        result = pattern.sub(lambda match: f"{match.group(1)}={_REDACTION}", result)
    return result


def sanitize_payload(payload: Any) -> Any:
    """Recursively sanitize keys and string values in collected provider payloads."""
    if isinstance(payload, str):
        return sanitize_text(payload)
    if isinstance(payload, list):
        return [sanitize_payload(item) for item in payload]
    if isinstance(payload, tuple):
        return tuple(sanitize_payload(item) for item in payload)
    if isinstance(payload, dict):
        sanitized: dict[Any, Any] = {}
        for key, value in payload.items():
            if isinstance(key, str) and _SENSITIVE_KEY_RE.fullmatch(key.strip()):
                sanitized[key] = _REDACTION
            else:
                sanitized[key] = sanitize_payload(value)
        return sanitized
    return payload
