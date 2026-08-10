from __future__ import annotations

import unittest
from datetime import datetime, timezone
from typing import Any

from intelligence.core.hashing import build_document_hash
from intelligence.core.models import IntelligenceDocument
from intelligence.errors.exceptions import StorageError
from intelligence.storage.memory_store import MemoryDocumentStore
from intelligence.storage.postgres_store import PostgresDocumentStore
from intelligence.storage.sqlite_store import SQLiteDocumentStore


NOW = datetime(2026, 8, 10, tzinfo=timezone.utc)


def document(document_id: str = "doc-1") -> IntelligenceDocument:
    value = IntelligenceDocument(
        id=document_id,
        source="web",
        content="trusted evidence",
        collected_at=NOW,
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


class FakeResult:
    def __init__(self, row: dict[str, Any]) -> None:
        self._row = row

    def fetchone(self) -> dict[str, Any]:
        return self._row


class FakeConnection:
    def __init__(self, row: dict[str, Any]) -> None:
        self._row = row

    def __enter__(self) -> "FakeConnection":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None

    def execute(self, query: str, params: Any = None) -> FakeResult:
        return FakeResult(self._row)


class OneConnectionFactory:
    def __init__(self, row: dict[str, Any]) -> None:
        self._row = row

    def __call__(self, *args, **kwargs) -> FakeConnection:
        return FakeConnection(self._row)


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

    def test_memory_store_detects_mutation_after_save_on_read(self) -> None:
        store = MemoryDocumentStore()
        value = document()
        store.save(value)
        value.content = "corrupted after save"
        with self.assertRaisesRegex(StorageError, "does not match evidence"):
            store.get(value.id)

    def test_sqlite_detects_persisted_row_corruption_on_read(self) -> None:
        with SQLiteDocumentStore(":memory:") as store:
            value = document()
            store.save(value)
            store._connection.execute(
                "UPDATE intelligence_documents SET content = ? WHERE id = ?",
                ("corrupted in database", value.id),
            )
            store._connection.commit()
            with self.assertRaisesRegex(StorageError, "does not match evidence"):
                store.get(value.id)

    def test_postgres_detects_persisted_row_corruption_on_read(self) -> None:
        value = document()
        row = {
            "id": value.id,
            "source": value.source,
            "content": "corrupted in database",
            "collected_at": value.collected_at,
            "url": value.url,
            "author": value.author,
            "provider": value.provider,
            "published_at": None,
            "entities_json": [],
            "metrics_json": {},
            "raw_hash": value.raw_hash,
        }
        store = PostgresDocumentStore(
            "postgresql://db/intelligence",
            connect_factory=OneConnectionFactory(row),
        )
        with self.assertRaisesRegex(StorageError, "does not match evidence"):
            store.get(value.id)

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
