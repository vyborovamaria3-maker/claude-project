from __future__ import annotations

import asyncio
import io
import json
import unittest
from contextlib import redirect_stderr, redirect_stdout
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from intelligence.cli import _worker_loop, main
from intelligence.errors.exceptions import QueueError


class FlakyWorker:
    def __init__(self, stop: asyncio.Event) -> None:
        self.stop = stop
        self.calls = 0

    async def run_next(self):
        self.calls += 1
        if self.calls == 1:
            raise QueueError("password=worker-secret host=/private/path")
        self.stop.set()
        return None


class ExplodingWorker:
    async def run_next(self):
        raise RuntimeError("token=implementation-secret /internal/path")


class CLIResilienceTests(unittest.TestCase):
    def test_worker_retries_known_runtime_errors_without_leaking_details(self) -> None:
        stderr = io.StringIO()

        async def scenario() -> tuple[int, int, AsyncMock]:
            stop = asyncio.Event()
            worker = FlakyWorker(stop)
            runtime = SimpleNamespace(worker=worker)
            waiter = AsyncMock(return_value=None)
            with patch("intelligence.cli._wait_for_stop", waiter):
                code = await _worker_loop(runtime, 0.1, stop_event=stop)
            return code, worker.calls, waiter

        with redirect_stderr(stderr):
            code, calls, waiter = asyncio.run(scenario())

        self.assertEqual(code, 0)
        self.assertEqual(calls, 2)
        self.assertGreaterEqual(waiter.await_count, 1)
        output = stderr.getvalue()
        self.assertIn("runtime_unavailable", output)
        self.assertNotIn("worker-secret", output)
        self.assertNotIn("/private/path", output)

    def test_worker_does_not_swallow_unknown_programming_errors(self) -> None:
        async def scenario() -> None:
            stop = asyncio.Event()
            runtime = SimpleNamespace(worker=ExplodingWorker())
            await _worker_loop(runtime, 0.1, stop_event=stop)

        with self.assertRaises(RuntimeError):
            asyncio.run(scenario())

    def test_postgres_init_db_calls_initializer_without_emitting_dsn(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()
        dsn = "postgresql://user:dsn-secret@db/intelligence"
        with patch("intelligence.cli.initialize_postgres_schema") as initializer:
            with redirect_stdout(stdout), redirect_stderr(stderr):
                code = main(
                    [
                        "--backend",
                        "postgres",
                        "--postgres-dsn",
                        dsn,
                        "init-db",
                    ]
                )

        self.assertEqual(code, 0)
        self.assertEqual(stderr.getvalue(), "")
        initializer.assert_called_once_with(dsn)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload, {"backend": "postgres", "initialized": True})
        self.assertNotIn("dsn-secret", stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
