from __future__ import annotations

import unittest
from datetime import datetime, timezone

from intelligence.core.hashing import build_document_hash
from intelligence.core.models import IntelligenceDocument
from intelligence.errors.exceptions import StorageError
from intelligence.storage.memory_store import MemoryDocumentStore
from intelligence.storage.postgres_store import PostgresDocumentStore
from intelligence.storage.sqlite_store import SQLiteDocumentStore


def document(document_id: str = "doc-1") -> IntelligenceDocument:
    value = IntelligenceDocument(
        id=document_id,
        source="web",
        content="trusted evidence",
        collected_at=datetime(2026, 8, 10, tzinfo=timezone.utc),
        url="https://example.com/evidence",
        author="example.com",
        provider="test",
    )
    value.raw_hash = build_document_hash(value)
    return value


class NeverConnect:
    def __init__(self) -> None:
        self.called = False

    def __call__(self, *args, **kwargs):
        self.called = True
        raise AssertionError("tampered evidence must be rejected before database connection")


class StorageIntegrityTests(unittest.TestCase):
    def _tampered(self) -> IntelligenceDocument:
        value = document()
        value.content = "tampered evidence"
        return value

    def test_valid_hash_is_accepted_by_memory_store(self) -> None:
        store = MemoryDocumentStore()
        value = document()
        saved = store.save(value)
        self.assertEqual(saved.id, value.id)
        self.assertEqual(len(store.list_all()), 1)

    def test_tampered_document_is_rejected_by_memory_store(self) -> None:
        store = MemoryDocumentStore()
        with self.assertRaisesRegex(StorageError, "does not match evidence"):
            store.save(self._tampered())
        self.assertEqual(store.list_all(), [])

    def test_tampered_document_is_rejected_by_sqlite_before_insert(self) -> None:
        with SQLiteDocumentStore(":memory:") as store:
            with self.assertRaisesRegex(StorageError, "does not match evidence"):
                store.save(self._tampered())
            self.assertEqual(store.list_all(), [])

    def test_tampered_document_is_rejected_before_postgres_connection(self) -> None:
        factory = NeverConnect()
        store = PostgresDocumentStore(
            "postgresql://db/intelligence",
            connect_factory=factory,
        )
        with self.assertRaisesRegex(StorageError, "does not match evidence"):
            store.save(self._tampered())
        self.assertFalse(factory.called)

    def test_malformed_hash_length_is_rejected(self) -> None:
        value = document()
        value.raw_hash = "short"
        with self.assertRaisesRegex(StorageError, "raw_hash is invalid"):
            MemoryDocumentStore().save(value)

    def test_documents_without_hash_remain_compatible(self) -> None:
        value = document()
        value.raw_hash = None
        store = MemoryDocumentStore()
        saved = store.save(value)
        self.assertEqual(saved.id, value.id)


if __name__ == "__main__":
    unittest.main()
