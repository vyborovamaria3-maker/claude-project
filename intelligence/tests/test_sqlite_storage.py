from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from intelligence.core.models import IntelligenceDocument
from intelligence.errors.exceptions import StorageError
from intelligence.storage.sqlite_store import SQLiteDocumentStore


def make_document(
    document_id: str = "doc-1",
    *,
    raw_hash: str | None = "a" * 64,
) -> IntelligenceDocument:
    return IntelligenceDocument(
        id=document_id,
        source="web",
        content="Evidence body",
        collected_at=datetime(2026, 8, 10, 4, 0, tzinfo=timezone.utc),
        url="https://example.com/evidence",
        author="example.com",
        provider="jina-reader",
        published_at=datetime(2026, 8, 9, 3, 0, tzinfo=timezone.utc),
        entities=["webpage", "example.com"],
        metrics={"characters": 13, "nested": {"ok": True}},
        raw_hash=raw_hash,
    )


class SQLiteDocumentStoreTests(unittest.TestCase):
    def test_memory_store_round_trip(self) -> None:
        with SQLiteDocumentStore(":memory:") as store:
            original = make_document()
            saved = store.save(original)
            loaded = store.get(saved.id)
            self.assertIsNotNone(loaded)
            assert loaded is not None
            self.assertEqual(loaded.id, original.id)
            self.assertEqual(loaded.source, original.source)
            self.assertEqual(loaded.content, original.content)
            self.assertEqual(loaded.collected_at, original.collected_at)
            self.assertEqual(loaded.url, original.url)
            self.assertEqual(loaded.author, original.author)
            self.assertEqual(loaded.provider, original.provider)
            self.assertEqual(loaded.published_at, original.published_at)
            self.assertEqual(loaded.entities, original.entities)
            self.assertEqual(loaded.metrics, original.metrics)
            self.assertEqual(loaded.raw_hash, original.raw_hash)

    def test_deduplicates_by_raw_hash(self) -> None:
        with SQLiteDocumentStore(":memory:") as store:
            first = store.save(make_document("first"))
            duplicate = store.save(make_document("second"))
            self.assertEqual(duplicate.id, first.id)
            self.assertEqual(len(store.list_all()), 1)
            self.assertEqual(store.find_by_hash("a" * 64).id, first.id)

    def test_documents_without_hash_are_not_deduplicated(self) -> None:
        with SQLiteDocumentStore(":memory:") as store:
            store.save(make_document("first", raw_hash=None))
            store.save(make_document("second", raw_hash=None))
            self.assertEqual(len(store.list_all()), 2)

    def test_file_store_survives_reopen(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "intelligence.sqlite3"
            with SQLiteDocumentStore(path) as store:
                store.save(make_document())
            with SQLiteDocumentStore(path) as reopened:
                loaded = reopened.get("doc-1")
                self.assertIsNotNone(loaded)
                self.assertEqual(len(reopened.list_all()), 1)

    def test_non_json_metrics_are_rejected(self) -> None:
        document = make_document()
        document.metrics = {"bad": object()}
        with SQLiteDocumentStore(":memory:") as store:
            with self.assertRaises(StorageError):
                store.save(document)
            self.assertEqual(store.list_all(), [])


if __name__ == "__main__":
    unittest.main()
