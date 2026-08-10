from __future__ import annotations

import io
import json
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone

from intelligence.bootstrap import IntelligenceRuntime
from intelligence.cli import main
from intelligence.core.hashing import build_document_hash
from intelligence.core.models import IntelligenceDocument, ProviderHealth
from intelligence.providers.base import IntelligenceProvider
from intelligence.providers.registry import ProviderRegistry
from intelligence.storage.memory_store import MemoryDocumentStore
from intelligence.worker.jobs import IntelligenceWorker
from intelligence.worker.queue import JobStatus, MemoryJobQueue


class FakeProvider(IntelligenceProvider):
    name = "fake"

    def __init__(self, *, healthy: bool = True) -> None:
        self._healthy = healthy

    async def collect(self, query: str) -> list[IntelligenceDocument]:
        document = IntelligenceDocument(
            id=f"doc-{query}",
            source="fake",
            content=f"evidence:{query}",
            collected_at=datetime.now(timezone.utc),
            provider="fake-test",
            url="https://example.com/evidence",
            author="fixture",
        )
        document.raw_hash = build_document_hash(document)
        return [document]

    async def health(self) -> ProviderHealth:
        return ProviderHealth(
            provider=self.name,
            healthy=self._healthy,
            latency_ms=1,
            details={"token": "provider-secret", "backend": "fake"},
        )


class RuntimeFactory:
    def __init__(self, *, healthy: bool = True) -> None:
        self.queue = MemoryJobQueue()
        self.store = MemoryDocumentStore()
        self.registry = ProviderRegistry([FakeProvider(healthy=healthy)])
        self.runtime = IntelligenceRuntime(
            registry=self.registry,
            queue=self.queue,
            store=self.store,
            worker=IntelligenceWorker(self.queue, self.registry, self.store),
        )

    def __call__(self, path):
        return self.runtime


class ExplodingRuntimeFactory:
    def __call__(self, path):
        raise RuntimeError("token=must-not-leak /secret/path")


class CLITests(unittest.TestCase):
    def run_cli(self, argv, factory):
        stdout = io.StringIO()
        stderr = io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = main(argv, runtime_factory=factory)
        return code, stdout.getvalue().strip(), stderr.getvalue().strip()

    def test_enqueue_outputs_bounded_non_secret_metadata(self) -> None:
        factory = RuntimeFactory()
        code, stdout, stderr = self.run_cli(
            ["--db", ":memory:", "enqueue", "fake", "token=super-secret"],
            factory,
        )
        self.assertEqual(code, 0)
        self.assertEqual(stderr, "")
        payload = json.loads(stdout)
        self.assertEqual(payload["status"], JobStatus.QUEUED.value)
        self.assertEqual(payload["provider"], "fake")
        self.assertNotIn("super-secret", stdout)

    def test_job_command_sanitizes_payload_and_error(self) -> None:
        factory = RuntimeFactory()
        job = factory.queue.submit({"provider": "fake", "query": "token=job-secret"})
        factory.queue.update_status(job.id, JobStatus.FAILED, "cookie=error-secret")

        code, stdout, _ = self.run_cli(["--db", ":memory:", "job", job.id], factory)
        self.assertEqual(code, 0)
        self.assertNotIn("job-secret", stdout)
        self.assertNotIn("error-secret", stdout)
        self.assertIn("[REDACTED]", stdout)

    def test_run_once_executes_and_persists_result(self) -> None:
        factory = RuntimeFactory()
        submitted = factory.queue.submit({"provider": "fake", "query": "alpha"})
        code, stdout, stderr = self.run_cli(["--db", ":memory:", "run-once"], factory)
        self.assertEqual(code, 0)
        self.assertEqual(stderr, "")
        payload = json.loads(stdout)
        self.assertEqual(payload["id"], submitted.id)
        self.assertEqual(payload["status"], JobStatus.COMPLETED.value)
        self.assertEqual(payload["result_document_ids"], ["doc-alpha"])
        self.assertIsNotNone(factory.store.get("doc-alpha"))

    def test_doctor_returns_nonzero_for_degraded_and_sanitizes_details(self) -> None:
        factory = RuntimeFactory(healthy=False)
        code, stdout, _ = self.run_cli(["--db", ":memory:", "doctor"], factory)
        self.assertEqual(code, 1)
        payload = json.loads(stdout)
        self.assertEqual(payload["degraded"], 1)
        self.assertEqual(payload["providers"][0]["details"]["token"], "[REDACTED]")
        self.assertNotIn("provider-secret", stdout)

    def test_documents_uses_recent_limit_and_omits_content(self) -> None:
        factory = RuntimeFactory()
        older = IntelligenceDocument(
            id="old",
            source="fake",
            content="content-must-not-be-emitted",
            collected_at=datetime(2026, 8, 1, tzinfo=timezone.utc),
        )
        newer = IntelligenceDocument(
            id="new",
            source="fake",
            content="second-secret-content",
            collected_at=datetime(2026, 8, 2, tzinfo=timezone.utc),
        )
        factory.store.save(older)
        factory.store.save(newer)

        code, stdout, _ = self.run_cli(
            ["--db", ":memory:", "documents", "--limit", "1"], factory
        )
        self.assertEqual(code, 0)
        payload = json.loads(stdout)
        self.assertEqual(payload["count"], 1)
        self.assertEqual(payload["documents"][0]["id"], "new")
        self.assertNotIn("content-must-not-be-emitted", stdout)
        self.assertNotIn("second-secret-content", stdout)

    def test_invalid_documents_limit_is_safe_domain_error(self) -> None:
        code, _, stderr = self.run_cli(
            ["--db", ":memory:", "documents", "--limit", "0"], RuntimeFactory()
        )
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(stderr)["error"], "limit must be between 1 and 1000")

    def test_unknown_runtime_failure_is_collapsed(self) -> None:
        code, stdout, stderr = self.run_cli(
            ["--db", ":memory:", "documents"], ExplodingRuntimeFactory()
        )
        self.assertEqual(code, 3)
        self.assertEqual(stdout, "")
        self.assertEqual(json.loads(stderr), {"error": "internal_cli_error"})
        self.assertNotIn("must-not-leak", stderr)
        self.assertNotIn("/secret/path", stderr)


if __name__ == "__main__":
    unittest.main()
