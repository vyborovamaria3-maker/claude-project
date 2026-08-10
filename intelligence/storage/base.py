"""Persistence contract for normalized intelligence documents."""

from __future__ import annotations

from typing import Protocol

from intelligence.core.models import IntelligenceDocument


class DocumentStore(Protocol):
    def save(self, document: IntelligenceDocument) -> IntelligenceDocument:
        """Persist a normalized document, returning an existing duplicate when applicable."""
        ...

    def get(self, document_id: str) -> IntelligenceDocument | None:
        ...

    def list_all(self) -> list[IntelligenceDocument]:
        ...

    def list_recent(self, limit: int) -> list[IntelligenceDocument]:
        """Return up to `limit` newest documents without loading the full store."""
        ...

    def find_by_hash(self, raw_hash: str) -> IntelligenceDocument | None:
        ...
