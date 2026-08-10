from __future__ import annotations

import asyncio
import unittest

from intelligence.bootstrap import build_memory_runtime
from intelligence.core.models import IntelligenceDocument, ProviderHealth
from intelligence.health.doctor import run_health_check, run_registry_health_check, summarize_health
from intelligence.providers.base import IntelligenceProvider
from intelligence.providers.registry import ProviderRegistry


class FakeProvider(IntelligenceProvider):
    def __init__(
        self,
        name: str,
        *,
        healthy: bool = True,
        delay: float = 0.0,
        details: dict | None = None,
        raises: Exception | None = None,
    ) -> None:
        self.name = name
        self._healthy = healthy
        self._delay = delay
        self._details = details or {}
        self._raises = raises

    async def collect(self, query: str) -> list[IntelligenceDocument]:
        return []

    async def health(self) -> ProviderHealth:
        if self._delay:
            await asyncio.sleep(self._delay)
        if self._raises is not None:
            raise self._raises
        return ProviderHealth(
            provider=self.name,
            healthy=self._healthy,
            latency_ms=7,
            details=dict(self._details),
        )


class BootstrapTests(unittest.TestCase):
    def test_memory_runtime_reuses_supplied_registry(self) -> None:
        registry = ProviderRegistry([FakeProvider("fake")])
        runtime = build_memory_runtime(registry=registry)
        self.assertIs(runtime.registry, registry)
        self.assertEqual(runtime.registry.names(), ("fake",))
        self.assertIs(runtime.worker.queue, runtime.queue)
        self.assertIs(runtime.worker.store, runtime.store)


class DoctorTests(unittest.IsolatedAsyncioTestCase):
    async def test_registry_health_uses_stable_provider_order(self) -> None:
        registry = ProviderRegistry(
            [FakeProvider("zeta"), FakeProvider("alpha"), FakeProvider("middle")]
        )
        results = await run_registry_health_check(registry)
        self.assertEqual([item.provider for item in results], ["alpha", "middle", "zeta"])

    async def test_health_checks_run_concurrently(self) -> None:
        providers = [FakeProvider("a", delay=0.08), FakeProvider("b", delay=0.08)]
        loop = asyncio.get_running_loop()
        started = loop.time()
        results = await run_health_check(providers)
        elapsed = loop.time() - started
        self.assertEqual(len(results), 2)
        # Sequential execution would be roughly 0.16s. Keep margin for busy CI hosts.
        self.assertLess(elapsed, 0.14)

    async def test_successful_health_details_are_sanitized(self) -> None:
        results = await run_health_check(
            [FakeProvider("safe", details={"token": "secret-value", "backend": "fake"})]
        )
        self.assertEqual(results[0].details["token"], "[REDACTED]")
        self.assertEqual(results[0].details["backend"], "fake")

    async def test_unexpected_failure_is_isolated_sanitized_and_capped(self) -> None:
        secret = "token=super-secret " + ("x" * 1000)
        results = await run_health_check([FakeProvider("broken", raises=RuntimeError(secret))])
        self.assertFalse(results[0].healthy)
        error = str(results[0].details["error"])
        self.assertNotIn("super-secret", error)
        self.assertLessEqual(len(error), 300)

    def test_summary_counts_and_sanitizes(self) -> None:
        summary = summarize_health(
            [
                ProviderHealth("a", True, 1, {"authorization": "Bearer secret"}),
                ProviderHealth("b", False, None, {"error": "offline"}),
            ]
        )
        self.assertEqual(summary["healthy"], 1)
        self.assertEqual(summary["degraded"], 1)
        self.assertEqual(summary["total"], 2)
        self.assertFalse(summary["all_healthy"])
        providers = summary["providers"]
        self.assertEqual(providers[0]["details"]["authorization"], "[REDACTED]")

    def test_empty_summary_is_not_all_healthy(self) -> None:
        summary = summarize_health([])
        self.assertEqual(summary["total"], 0)
        self.assertFalse(summary["all_healthy"])


if __name__ == "__main__":
    unittest.main()
