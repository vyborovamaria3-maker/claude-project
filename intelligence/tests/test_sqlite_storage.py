from __future__ import annotations

import sqlite3
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
    collected_at: datetime | None = None,
) -> IntelligenceDocument:
    return IntelligenceDocument(
        id=document_id,
        source="web",
        content="Evidence body",
        collected_at=collected_at or datetime(2026, 8, 10, 4, 0, tzinfo=timezone.utc),
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
            found = store.find_by_hash("a" * 64)
            self.assertIsNotNone(found)
            assert found is not None
            self.assertEqual(found.id, first.id)

    def test_documents_without_hash_are_not_deduplicated(self) -> None:
        with SQLiteDocumentStore(":memory:") as store:
            store.save(make_document("first", raw_hash=None))
            store.save(make_document("second", raw_hash=None))
            self.assertEqual(len(store.list_all()), 2)

    def test_file_store_survives_reopen_and_uses_wal(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "intelligence.sqlite3"
            with SQLiteDocumentStore(path) as store:
                store.save(make_document())
                mode = store._connection.execute("PRAGMA journal_mode").fetchone()[0]
                timeout = store._connection.execute("PRAGMA busy_timeout").fetchone()[0]
                self.assertEqual(str(mode).lower(), "wal")
                self.assertEqual(int(timeout), 5000)
            with SQLiteDocumentStore(path) as reopened:
                loaded = reopened.get("doc-1")
                self.assertIsNotNone(loaded)
                self.assertEqual(len(reopened.list_all()), 1)

    def test_list_recent_is_bounded_and_newest_first(self) -> None:
        with SQLiteDocumentStore(":memory:") as store:
            store.save(
                make_document(
                    "old",
                    raw_hash="b" * 64,
                    collected_at=datetime(2026, 8, 1, tzinfo=timezone.utc),
                )
            )
            store.save(
                make_document(
                    "new",
                    raw_hash="c" * 64,
                    collected_at=datetime(2026, 8, 2, tzinfo=timezone.utc),
                )
            )
            rows = store.list_recent(1)
            self.assertEqual([row.id for row in rows], ["new"])
            with self.assertRaises(ValueError):
                store.list_recent(0)

    def test_non_json_metrics_are_rejected(self) -> None:
        document = make_document()
        document.metrics = {"bad": object()}
        with SQLiteDocumentStore(":memory:") as store:
            with self.assertRaises(StorageError):
                store.save(document)
            self.assertEqual(store.list_all(), [])

    def test_constraint_failure_rolls_back_and_store_remains_usable(self) -> None:
        with SQLiteDocumentStore(":memory:") as store:
            store.save(make_document("same-id", raw_hash="a" * 64))
            with self.assertRaises(StorageError):
                store.save(make_document("same-id", raw_hash="b" * 64))

            recovered = store.save(make_document("after-error", raw_hash="c" * 64))
            self.assertEqual(recovered.id, "after-error")
            self.assertEqual(len(store.list_all()), 2)


if __name__ == "__main__":
    unittest.main()
