from __future__ import annotations

from dataclasses import dataclass

from intelligence.core.models import IntelligenceDocument


@dataclass(slots=True)
class MemoryDocumentStore:
    documents: dict[str, IntelligenceDocument]

    def __init__(self) -> None:
        self.documents = {}

    def save(self, document: IntelligenceDocument) -> IntelligenceDocument:
        self.documents[document.id] = document
        return document

    def get(self, document_id: str) -> IntelligenceDocument | None:
        return self.documents.get(document_id)

    def list_all(self) -> list[IntelligenceDocument]:
        return list(self.documents.values())

    def find_by_hash(self, raw_hash: str) -> IntelligenceDocument | None:
        return next(
            (doc for doc in self.documents.values() if doc.raw_hash == raw_hash),
            None,
        )
