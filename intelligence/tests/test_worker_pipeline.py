from __future__ import annotations

import unittest
from datetime import datetime, timezone

from intelligence.core.hashing import build_document_hash
from intelligence.core.models import IntelligenceDocument, ProviderHealth
from intelligence.errors.exceptions import ProviderError
from intelligence.providers.base import IntelligenceProvider
from intelligence.providers.registry import ProviderRegistry
from intelligence.storage.memory_store import MemoryDocumentStore
from intelligence.worker.jobs import IntelligenceWorker
from intelligence.worker.queue import JobStatus, MemoryJobQueue


class FakeProvider(IntelligenceProvider):
    name = "fake"

    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.collect_calls = 0

    async def collect(self, query: str) -> list[IntelligenceDocument]:
        self.collect_calls += 1
        if self.fail:
            raise ProviderError("token=provider-secret upstream failed")
        document = IntelligenceDocument(
            id=f"doc-{self.collect_calls}",
            source="fake",
            content=f"evidence:{query}",
            collected_at=datetime.now(timezone.utc),
            url="https://example.com/evidence",
            author="fixture",
            provider="fake-test",
        )
        document.raw_hash = build_document_hash(document)
        return [document]

    async def health(self) -> ProviderHealth:
        return ProviderHealth(provider=self.name, healthy=True)


class WorkerPipelineTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.queue = MemoryJobQueue()
        self.store = MemoryDocumentStore()
        self.provider = FakeProvider()
        self.registry = ProviderRegistry([self.provider])
        self.worker = IntelligenceWorker(self.queue, self.registry, self.store)

    async def test_successful_job_collects_and_persists_evidence(self) -> None:
        job = self.queue.submit({"provider": "fake", "query": "BONK"})
        result = await self.worker.run(job)

        self.assertEqual(result.status, JobStatus.COMPLETED)
        self.assertIsNotNone(result.started_at)
        self.assertIsNotNone(result.finished_at)
        self.assertIsNone(result.error)
        self.assertEqual(len(result.result_document_ids), 1)
        stored = self.store.get(result.result_document_ids[0])
        self.assertIsNotNone(stored)
        self.assertEqual(stored.content, "evidence:BONK")

    async def test_duplicate_evidence_reuses_existing_document(self) -> None:
        first = self.queue.submit({"provider": "fake", "query": "same"})
        second = self.queue.submit({"provider": "fake", "query": "same"})
        await self.worker.run(first)
        await self.worker.run(second)

        self.assertEqual(len(self.store.list_all()), 1)
        self.assertEqual(first.result_document_ids, second.result_document_ids)

    async def test_unknown_provider_fails_without_calling_collect(self) -> None:
        job = self.queue.submit({"provider": "missing", "query": "x"})
        result = await self.worker.run(job)
        self.assertEqual(result.status, JobStatus.FAILED)
        self.assertIn("not registered", result.error or "")
        self.assertEqual(self.provider.collect_calls, 0)
        self.assertIsNotNone(result.finished_at)

    async def test_invalid_payload_fails_before_provider_execution(self) -> None:
        for payload in (
            {"query": "x"},
            {"provider": "fake"},
            {"provider": "", "query": "x"},
            {"provider": "fake", "query": ""},
        ):
            with self.subTest(payload=payload):
                job = self.queue.submit(payload)
                result = await self.worker.run(job)
                self.assertEqual(result.status, JobStatus.FAILED)
        self.assertEqual(self.provider.collect_calls, 0)

    async def test_provider_error_is_sanitized(self) -> None:
        failing_provider = FakeProvider(fail=True)
        worker = IntelligenceWorker(
            self.queue,
            ProviderRegistry([failing_provider]),
            self.store,
        )
        job = self.queue.submit({"provider": "fake", "query": "x"})
        result = await worker.run(job)
        self.assertEqual(result.status, JobStatus.FAILED)
        self.assertIn("[REDACTED]", result.error or "")
        self.assertNotIn("provider-secret", result.error or "")


class ProviderRegistryTests(unittest.TestCase):
    def test_registry_rejects_duplicate_names(self) -> None:
        registry = ProviderRegistry([FakeProvider()])
        with self.assertRaises(ValueError):
            registry.register(FakeProvider())

    def test_registry_names_are_stable_and_sorted(self) -> None:
        registry = ProviderRegistry([FakeProvider()])
        self.assertEqual(registry.names(), ("fake",))


if __name__ == "__main__":
    unittest.main()
