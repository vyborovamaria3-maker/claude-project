from __future__ import annotations

from dataclasses import dataclass

from intelligence.core.models import IntelligenceDocument
from intelligence.storage.integrity import validate_document_integrity


@dataclass(slots=True)
class MemoryDocumentStore:
    documents: dict[str, IntelligenceDocument]
    _hash_index: dict[str, str]

    def __init__(self) -> None:
        self.documents = {}
        self._hash_index = {}

    def save(self, document: IntelligenceDocument) -> IntelligenceDocument:
        validate_document_integrity(document)
        if document.raw_hash:
            existing_id = self._hash_index.get(document.raw_hash)
            if existing_id is not None:
                return self.documents[existing_id]

        self.documents[document.id] = document
        if document.raw_hash:
            self._hash_index[document.raw_hash] = document.id
        return document

    def get(self, document_id: str) -> IntelligenceDocument | None:
        return self.documents.get(document_id)

    def list_all(self) -> list[IntelligenceDocument]:
        return list(self.documents.values())

    def list_recent(self, limit: int) -> list[IntelligenceDocument]:
        if limit < 1:
            raise ValueError("limit must be > 0")
        return sorted(
            self.documents.values(),
            key=lambda document: (document.collected_at, document.id),
            reverse=True,
        )[:limit]

    def find_by_hash(self, raw_hash: str) -> IntelligenceDocument | None:
        document_id = self._hash_index.get(raw_hash)
        return self.documents.get(document_id) if document_id is not None else None
