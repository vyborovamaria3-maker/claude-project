"""Integrity checks shared by all normalized document stores."""

from __future__ import annotations

import hmac

from intelligence.core.hashing import build_document_hash
from intelligence.core.models import IntelligenceDocument
from intelligence.errors.exceptions import StorageError


def validate_document_integrity(document: IntelligenceDocument) -> None:
    """Reject a supplied evidence fingerprint that no longer matches the document.

    Documents without `raw_hash` remain allowed for compatibility with manually
    constructed/local fixtures. Provider-normalized evidence normally carries a hash.
    """
    if document.raw_hash is None:
        return
    if not isinstance(document.raw_hash, str) or len(document.raw_hash) != 64:
        raise StorageError("intelligence document raw_hash is invalid")
    expected = build_document_hash(document)
    if not hmac.compare_digest(document.raw_hash, expected):
        raise StorageError("intelligence document raw_hash does not match evidence")
