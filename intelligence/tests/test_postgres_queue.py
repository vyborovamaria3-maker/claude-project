from __future__ import annotations

import unittest
from datetime import datetime, timezone
from typing import Any
from unittest.mock import patch

import psycopg
from psycopg.types.json import Jsonb

from intelligence.errors.exceptions import QueueError
from intelligence.worker.postgres_queue import PostgresJobQueue
from intelligence.worker.queue import JobStatus


NOW = datetime(2026, 8, 10, 6, 0, tzinfo=timezone.utc)


def job_row(
    job_id: str = "job-1",
    *,
    status: str = "queued",
    started_at: datetime | None = None,
    finished_at: datetime | None = None,
    result_ids: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "id": job_id,
        "payload_json": {"provider": "web", "query": "https://example.com"},
        "status": status,
        "created_at": NOW,
        "started_at": started_at,
        "finished_at": finished_at,
        "result_document_ids_json": result_ids or [],
        "error": None,
    }


class FakeResult:
    def __init__(self, *, one: Any = None, rowcount: int = 1) -> None:
        self.one = one
        self.rowcount = rowcount

    def fetchone(self) -> Any:
        return self.one


class FakeConnection:
    def __init__(self, results: list[FakeResult]) -> None:
        self.results = list(results)
        self.calls: list[tuple[str, Any]] = []

    def __enter__(self) -> "FakeConnection":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        return None

    def execute(self, query: str, params: Any = None) -> FakeResult:
        self.calls.append((query, params))
        if not self.results:
            raise AssertionError("unexpected SQL execution")
        return self.results.pop(0)


class ConnectFactory:
    def __init__(self, connections: list[FakeConnection]) -> None:
        self.connections = list(connections)
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def __call__(self, dsn: str, **kwargs: Any) -> FakeConnection:
        self.calls.append((dsn, kwargs))
        if not self.connections:
            raise AssertionError("unexpected connection")
        return self.connections.pop(0)


class PostgresJobQueueTests(unittest.TestCase):
    def test_submit_uses_jsonb_and_returns_queued_job(self) -> None:
        connection = FakeConnection([FakeResult(one=job_row())])
        factory = ConnectFactory([connection])
        queue = PostgresJobQueue("postgresql://db/intelligence", connect_factory=factory)

        submitted = queue.submit({"provider": "web", "query": "https://example.com"})

        self.assertEqual(submitted.status, JobStatus.QUEUED)
        query, params = connection.calls[0]
        self.assertIn("INSERT INTO intelligence_jobs", query)
        self.assertIsInstance(params[1], Jsonb)
        self.assertIsInstance(params[4], Jsonb)
        self.assertIn("row_factory", factory.calls[0][1])
        self.assertEqual(factory.calls[0][1]["connect_timeout"], 5)

    def test_claim_uses_skip_locked_and_returns_running_job(self) -> None:
        claimed_row = job_row(status="running", started_at=NOW)
        connection = FakeConnection(
            [
                FakeResult(one=job_row()),
                FakeResult(one=claimed_row),
            ]
        )
        queue = PostgresJobQueue(
            "postgresql://db/intelligence",
            connect_factory=ConnectFactory([connection]),
        )

        claimed = queue.claim_next()

        self.assertIsNotNone(claimed)
        assert claimed is not None
        self.assertEqual(claimed.status, JobStatus.RUNNING)
        self.assertIn("FOR UPDATE SKIP LOCKED", connection.calls[0][0])
        self.assertIn("RETURNING", connection.calls[1][0])

    def test_claim_returns_none_when_queue_is_empty(self) -> None:
        connection = FakeConnection([FakeResult(one=None)])
        queue = PostgresJobQueue(
            "postgresql://db/intelligence",
            connect_factory=ConnectFactory([connection]),
        )
        self.assertIsNone(queue.claim_next())
        self.assertEqual(len(connection.calls), 1)

    def test_update_status_locks_row_and_applies_state_machine(self) -> None:
        connection = FakeConnection(
            [
                FakeResult(one={"status": "running"}),
                FakeResult(rowcount=1),
            ]
        )
        queue = PostgresJobQueue(
            "postgresql://db/intelligence",
            connect_factory=ConnectFactory([connection]),
        )

        queue.update_status("job-1", JobStatus.COMPLETED)

        self.assertIn("FOR UPDATE", connection.calls[0][0])
        self.assertIn("finished_at", connection.calls[1][0])
        self.assertEqual(connection.calls[1][1][0], JobStatus.COMPLETED.value)

    def test_invalid_terminal_transition_is_rejected_before_update(self) -> None:
        connection = FakeConnection([FakeResult(one={"status": "completed"})])
        queue = PostgresJobQueue(
            "postgresql://db/intelligence",
            connect_factory=ConnectFactory([connection]),
        )

        with self.assertRaises(QueueError):
            queue.update_status("job-1", JobStatus.RUNNING)
        self.assertEqual(len(connection.calls), 1)

    def test_set_results_deduplicates_ids_before_jsonb_wrapping(self) -> None:
        connection = FakeConnection([FakeResult(one={"id": "job-1"})])
        queue = PostgresJobQueue(
            "postgresql://db/intelligence",
            connect_factory=ConnectFactory([connection]),
        )

        with patch(
            "intelligence.worker.postgres_queue.Jsonb",
            side_effect=lambda value: ("jsonb", value),
        ):
            queue.set_results("job-1", ["doc-1", "doc-1", "doc-2"])

        _, params = connection.calls[0]
        self.assertEqual(params[0], ("jsonb", ["doc-1", "doc-2"]))

    def test_malformed_job_row_is_rejected(self) -> None:
        bad = job_row()
        bad["result_document_ids_json"] = ["ok", 123]
        connection = FakeConnection([FakeResult(one=bad)])
        queue = PostgresJobQueue(
            "postgresql://db/intelligence",
            connect_factory=ConnectFactory([connection]),
        )
        with self.assertRaises(QueueError):
            queue.get("job-1")

    def test_connection_error_does_not_expose_dsn_or_driver_message(self) -> None:
        class FailingFactory:
            def __call__(self, dsn: str, **kwargs: Any) -> Any:
                raise psycopg.OperationalError("password=super-secret host=internal-db")

        queue = PostgresJobQueue(
            "postgresql://user:dsn-secret@internal-db/intelligence",
            connect_factory=FailingFactory(),
        )
        with self.assertRaises(QueueError) as captured:
            queue.get("job-1")
        message = str(captured.exception)
        self.assertNotIn("super-secret", message)
        self.assertNotIn("dsn-secret", message)
        self.assertNotIn("internal-db", message)


if __name__ == "__main__":
    unittest.main()
