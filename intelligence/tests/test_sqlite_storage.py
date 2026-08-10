from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from intelligence.core.hashing import build_document_hash
from intelligence.core.models import IntelligenceDocument
from intelligence.errors.exceptions import StorageError
from intelligence.storage.sqlite_store import SQLiteDocumentStore


def make_document(
    document_id: str = "doc-1",
    *,
    with_hash: bool = True,
    collected_at: datetime | None = None,
    url: str = "https://example.com/evidence",
) -> IntelligenceDocument:
    document = IntelligenceDocument(
        id=document_id,
        source="web",
        content="Evidence body",
        collected_at=collected_at or datetime(2026, 8, 10, 4, 0, tzinfo=timezone.utc),
        url=url,
        author="example.com",
        provider="jina-reader",
        published_at=datetime(2026, 8, 9, 3, 0, tzinfo=timezone.utc),
        entities=["webpage", "example.com"],
        metrics={"characters": 13, "nested": {"ok": True}},
    )
    if with_hash:
        document.raw_hash = build_document_hash(document)
    return document


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
            assert first.raw_hash is not None
            found = store.find_by_hash(first.raw_hash)
            self.assertIsNotNone(found)
            assert found is not None
            self.assertEqual(found.id, first.id)

    def test_documents_without_hash_are_not_deduplicated(self) -> None:
        with SQLiteDocumentStore(":memory:") as store:
            store.save(make_document("first", with_hash=False))
            store.save(make_document("second", with_hash=False))
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
                    collected_at=datetime(2026, 8, 1, tzinfo=timezone.utc),
                    url="https://example.com/evidence/old",
                )
            )
            store.save(
                make_document(
                    "new",
                    collected_at=datetime(2026, 8, 2, tzinfo=timezone.utc),
                    url="https://example.com/evidence/new",
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
            store.save(make_document("same-id", url="https://example.com/one"))
            with self.assertRaises(StorageError):
                store.save(make_document("same-id", url="https://example.com/two"))

            recovered = store.save(make_document("after-error", url="https://example.com/three"))
            self.assertEqual(recovered.id, "after-error")
            self.assertEqual(len(store.list_all()), 2)


if __name__ == "__main__":
    unittest.main()
