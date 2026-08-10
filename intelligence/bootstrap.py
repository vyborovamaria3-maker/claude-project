"""Bootstrap helpers for the POTAPoff intelligence subsystem."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from intelligence.providers.github.provider import GitHubIntelligenceProvider
from intelligence.providers.registry import ProviderRegistry
from intelligence.providers.rss.provider import RSSIntelligenceProvider
from intelligence.providers.web.provider import WebIntelligenceProvider
from intelligence.providers.youtube.provider import YouTubeIntelligenceProvider
from intelligence.storage.base import DocumentStore
from intelligence.storage.memory_store import MemoryDocumentStore
from intelligence.storage.sqlite_store import SQLiteDocumentStore
from intelligence.worker.jobs import IntelligenceWorker
from intelligence.worker.queue import MemoryJobQueue


@dataclass(slots=True)
class IntelligenceRuntime:
    registry: ProviderRegistry
    queue: MemoryJobQueue
    store: DocumentStore
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


def _build_runtime(registry: ProviderRegistry, store: DocumentStore) -> IntelligenceRuntime:
    queue = MemoryJobQueue()
    worker = IntelligenceWorker(queue, registry, store)
    return IntelligenceRuntime(
        registry=registry,
        queue=queue,
        store=store,
        worker=worker,
    )


def build_memory_runtime(*, registry: ProviderRegistry | None = None) -> IntelligenceRuntime:
    """Build an in-memory runtime suitable for local execution and tests."""
    return _build_runtime(registry or build_default_registry(), MemoryDocumentStore())


def build_sqlite_runtime(
    path: str | Path,
    *,
    registry: ProviderRegistry | None = None,
) -> IntelligenceRuntime:
    """Build a durable local runtime backed by SQLite normalized storage."""
    return _build_runtime(registry or build_default_registry(), SQLiteDocumentStore(path))
