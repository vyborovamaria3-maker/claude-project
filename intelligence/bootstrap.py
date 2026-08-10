"""Bootstrap helpers for the POTAPoff intelligence subsystem."""

from __future__ import annotations

from dataclasses import dataclass

from intelligence.providers.github.provider import GitHubIntelligenceProvider
from intelligence.providers.registry import ProviderRegistry
from intelligence.providers.rss.provider import RSSIntelligenceProvider
from intelligence.providers.web.provider import WebIntelligenceProvider
from intelligence.providers.youtube.provider import YouTubeIntelligenceProvider
from intelligence.storage.memory_store import MemoryDocumentStore
from intelligence.worker.jobs import IntelligenceWorker
from intelligence.worker.queue import MemoryJobQueue


@dataclass(slots=True)
class IntelligenceRuntime:
    registry: ProviderRegistry
    queue: MemoryJobQueue
    store: MemoryDocumentStore
    worker: IntelligenceWorker


def build_default_registry() -> ProviderRegistry:
    """Return the standard provider set without performing network I/O."""
    return ProviderRegistry(
        [
            GitHubIntelligenceProvider(),
            WebIntelligenceProvider(),
            RSSIntelligenceProvider(),
            YouTubeIntelligenceProvider(),
        ]
    )


def build_memory_runtime(*, registry: ProviderRegistry | None = None) -> IntelligenceRuntime:
    """Build an in-memory runtime suitable for local execution and tests."""
    resolved_registry = registry or build_default_registry()
    queue = MemoryJobQueue()
    store = MemoryDocumentStore()
    worker = IntelligenceWorker(queue, resolved_registry, store)
    return IntelligenceRuntime(
        registry=resolved_registry,
        queue=queue,
        store=store,
        worker=worker,
    )
