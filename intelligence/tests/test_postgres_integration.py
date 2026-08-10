from __future__ import annotations

import os
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from uuid import uuid4

import psycopg

from intelligence.core.models import IntelligenceDocument
from intelligence.storage.postgres_schema import initialize_postgres_schema
from intelligence.storage.postgres_store import PostgresDocumentStore
from intelligence.worker.postgres_queue import PostgresJobQueue
from intelligence.worker.queue import JobStatus


TEST_DSN_ENV = "POTAPOFF_TEST_POSTGRES_DSN"
READONLY_DSN_ENV = "POTAPOFF_TEST_POSTGRES_READONLY_DSN"


def _dsn() -> str:
    return os.getenv(TEST_DSN_ENV, "").strip()


def _readonly_dsn() -> str:
    return os.getenv(READONLY_DSN_ENV, "").strip()


@unittest.skipUnless(_dsn(), f"set {TEST_DSN_ENV} to run live PostgreSQL tests")
class PostgresIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.dsn = _dsn()
        initialize_postgres_schema(cls.dsn)

    def setUp(self) -> None:
        with psycopg.connect(self.dsn) as connection:
            connection.execute("TRUNCATE TABLE intelligence_jobs, intelligence_documents")

    def test_document_round_trip_and_raw_hash_dedup(self) -> None:
        store = PostgresDocumentStore(self.dsn)
        raw_hash = uuid4().hex + uuid4().hex
        collected_at = datetime.now(timezone.utc)
        first = IntelligenceDocument(
            id=f"doc-{uuid4()}",
            source="integration",
            content="first evidence",
            collected_at=collected_at,
            provider="integration-test",
            entities=["integration"],
            metrics={"score": 1},
            raw_hash=raw_hash,
        )
        duplicate = IntelligenceDocument(
            id=f"doc-{uuid4()}",
            source="integration",
            content="duplicate evidence",
            collected_at=collected_at,
            provider="integration-test",
            entities=["integration"],
            metrics={"score": 2},
            raw_hash=raw_hash,
        )

        saved_first = store.save(first)
        saved_duplicate = store.save(duplicate)

        self.assertEqual(saved_first.id, first.id)
        self.assertEqual(saved_duplicate.id, first.id)
        loaded = store.get(first.id)
        self.assertIsNotNone(loaded)
        assert loaded is not None
        self.assertEqual(loaded.content, "first evidence")
        self.assertEqual(loaded.metrics, {"score": 1})
        found = store.find_by_hash(raw_hash)
        self.assertIsNotNone(found)
        assert found is not None
        self.assertEqual(found.id, first.id)

    def test_two_workers_claim_distinct_jobs_with_skip_locked(self) -> None:
        queue_a = PostgresJobQueue(self.dsn)
        queue_b = PostgresJobQueue(self.dsn)
        submitted = {
            queue_a.submit({"provider": "web", "query": "https://example.com/a"}).id,
            queue_a.submit({"provider": "web", "query": "https://example.com/b"}).id,
        }

        with ThreadPoolExecutor(max_workers=2) as pool:
            claimed = list(pool.map(lambda queue: queue.claim_next(), (queue_a, queue_b)))

        self.assertTrue(all(job is not None for job in claimed))
        claimed_ids = {job.id for job in claimed if job is not None}
        self.assertEqual(claimed_ids, submitted)
        self.assertTrue(all(job.status == JobStatus.RUNNING for job in claimed if job is not None))
        self.assertIsNone(queue_a.claim_next())

    def test_schema_initialization_is_idempotent(self) -> None:
        initialize_postgres_schema(self.dsn)
        initialize_postgres_schema(self.dsn)
        with psycopg.connect(self.dsn) as connection:
            rows = connection.execute(
                """
                SELECT table_name
                FROM information_schema.tables
                WHERE table_schema = current_schema()
                  AND table_name IN ('intelligence_documents', 'intelligence_jobs')
                ORDER BY table_name
                """
            ).fetchall()
        self.assertEqual(
            [row[0] for row in rows],
            ["intelligence_documents", "intelligence_jobs"],
        )

    @unittest.skipUnless(
        _readonly_dsn(),
        f"set {READONLY_DSN_ENV} to verify the admin SELECT-only database role",
    )
    def test_readonly_admin_role_can_select_but_cannot_write(self) -> None:
        with psycopg.connect(_readonly_dsn()) as connection:
            connection.execute("SELECT COUNT(*) FROM intelligence_documents").fetchone()
            with self.assertRaises(psycopg.Error):
                connection.execute(
                    """
                    INSERT INTO intelligence_documents (
                        id, source, content, collected_at, entities_json, metrics_json
                    ) VALUES (%s, %s, %s, NOW(), '[]'::jsonb, '{}'::jsonb)
                    """,
                    (f"forbidden-{uuid4()}", "integration", "must fail"),
                )
            connection.rollback()
            connection.execute("SELECT COUNT(*) FROM intelligence_jobs").fetchone()


if __name__ == "__main__":
    unittest.main()
