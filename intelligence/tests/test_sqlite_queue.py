from __future__ import annotations

import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from intelligence.core.hashing import build_document_hash
from intelligence.core.models import IntelligenceDocument, ProviderHealth
from intelligence.errors.exceptions import QueueError
from intelligence.providers.base import IntelligenceProvider
from intelligence.providers.registry import ProviderRegistry
from intelligence.storage.sqlite_store import SQLiteDocumentStore
from intelligence.worker.jobs import IntelligenceWorker
from intelligence.worker.queue import JobStatus
from intelligence.worker.sqlite_queue import SQLiteJobQueue


class FakeProvider(IntelligenceProvider):
    name = "fake"

    async def collect(self, query: str) -> list[IntelligenceDocument]:
        document = IntelligenceDocument(
            id=f"doc-{query}",
            source="fake",
            content=f"evidence:{query}",
            collected_at=datetime.now(timezone.utc),
            provider="fake-test",
        )
        document.raw_hash = build_document_hash(document)
        return [document]

    async def health(self) -> ProviderHealth:
        return ProviderHealth(provider=self.name, healthy=True)


class SQLiteJobQueueTests(unittest.TestCase):
    def test_queue_survives_reopen(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "runtime.sqlite3"
            with SQLiteJobQueue(path) as queue:
                submitted = queue.submit({"provider": "fake", "query": "one"})
            with SQLiteJobQueue(path) as reopened:
                loaded = reopened.get(submitted.id)
                self.assertIsNotNone(loaded)
                assert loaded is not None
                self.assertEqual(loaded.status, JobStatus.QUEUED)
                self.assertEqual(loaded.payload["query"], "one")

    def test_file_backed_queue_enables_wal(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "runtime.sqlite3"
            with SQLiteJobQueue(path):
                with sqlite3.connect(path) as reader:
                    mode = reader.execute("PRAGMA journal_mode").fetchone()
                    self.assertIsNotNone(mode)
                    assert mode is not None
                    self.assertEqual(str(mode[0]).lower(), "wal")

    def test_claim_is_atomic_across_queue_instances(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "runtime.sqlite3"
            with SQLiteJobQueue(path) as first, SQLiteJobQueue(path) as second:
                submitted = first.submit({"provider": "fake", "query": "one"})
                claimed = first.claim_next()
                self.assertIsNotNone(claimed)
                assert claimed is not None
                self.assertEqual(claimed.id, submitted.id)
                self.assertEqual(claimed.status, JobStatus.RUNNING)
                self.assertIsNone(second.claim_next())

    def test_repeated_running_and_completed_status_preserve_timestamps(self) -> None:
        with SQLiteJobQueue(":memory:") as queue:
            submitted = queue.submit({"provider": "fake", "query": "one"})
            queue.update_status(submitted.id, JobStatus.RUNNING)
            running = queue.get(submitted.id)
            self.assertIsNotNone(running)
            assert running is not None
            first_started_at = running.started_at
            self.assertIsNotNone(first_started_at)

            queue.update_status(submitted.id, JobStatus.RUNNING)
            running_again = queue.get(submitted.id)
            self.assertIsNotNone(running_again)
            assert running_again is not None
            self.assertEqual(running_again.started_at, first_started_at)

            queue.update_status(submitted.id, JobStatus.COMPLETED)
            completed = queue.get(submitted.id)
            self.assertIsNotNone(completed)
            assert completed is not None
            first_finished_at = completed.finished_at
            self.assertIsNotNone(first_finished_at)

            queue.update_status(submitted.id, JobStatus.COMPLETED)
            completed_again = queue.get(submitted.id)
            self.assertIsNotNone(completed_again)
            assert completed_again is not None
            self.assertEqual(completed_again.finished_at, first_finished_at)

    def test_completed_job_cannot_return_to_running(self) -> None:
        with SQLiteJobQueue(":memory:") as queue:
            submitted = queue.submit({"provider": "fake", "query": "one"})
            claimed = queue.claim_next()
            self.assertIsNotNone(claimed)
            queue.set_results(submitted.id, ["doc-1", "doc-1"])
            queue.update_status(submitted.id, JobStatus.COMPLETED)
            completed = queue.get(submitted.id)
            self.assertIsNotNone(completed)
            assert completed is not None
            self.assertEqual(completed.result_document_ids, ["doc-1"])
            with self.assertRaises(QueueError):
                queue.update_status(submitted.id, JobStatus.RUNNING)

    def test_non_json_payload_is_rejected(self) -> None:
        with SQLiteJobQueue(":memory:") as queue:
            with self.assertRaises(QueueError):
                queue.submit({"provider": "fake", "query": object()})


class DurableWorkerTests(unittest.IsolatedAsyncioTestCase):
    async def test_run_next_persists_job_and_document(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "runtime.sqlite3"
            with SQLiteJobQueue(path) as queue, SQLiteDocumentStore(path) as store:
                registry = ProviderRegistry([FakeProvider()])
                worker = IntelligenceWorker(queue, registry, store)
                submitted = queue.submit({"provider": "fake", "query": "alpha"})

                completed = await worker.run_next()
                self.assertIsNotNone(completed)
                assert completed is not None
                self.assertEqual(completed.id, submitted.id)
                self.assertEqual(completed.status, JobStatus.COMPLETED)
                self.assertIsNotNone(completed.started_at)
                self.assertIsNotNone(completed.finished_at)
                self.assertEqual(completed.result_document_ids, ["doc-alpha"])

                stored = store.get("doc-alpha")
                self.assertIsNotNone(stored)
                self.assertIsNone(await worker.run_next())


if __name__ == "__main__":
    unittest.main()
