"""Bootstrap helpers for the POTAPoff intelligence subsystem."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from intelligence.providers.github.provider import GitHubIntelligenceProvider
from intelligence.providers.registry import ProviderRegistry
from intelligence.providers.rss.provider import RSSIntelligenceProvider
from intelligence.providers.web.provider import WebIntelligenceProvider
from intelligence.providers.youtube.provider import YouTubeIntelligenceProvider
from intelligence.storage.base import DocumentStore
from intelligence.storage.memory_store import MemoryDocumentStore
from intelligence.storage.sqlite_store import SQLiteDocumentStore
from intelligence.worker.base import JobQueue
from intelligence.worker.jobs import IntelligenceWorker
from intelligence.worker.queue import MemoryJobQueue
from intelligence.worker.sqlite_queue import SQLiteJobQueue


@dataclass(slots=True)
class IntelligenceRuntime:
    registry: ProviderRegistry
    queue: JobQueue
    store: DocumentStore
    worker: IntelligenceWorker

    def close(self) -> None:
        """Close durable resources when the selected backends expose close()."""
        for resource in (self.queue, self.store):
            close = getattr(resource, "close", None)
            if callable(close):
                close()

    def __enter__(self) -> "IntelligenceRuntime":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.close()


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


def _build_runtime(
    registry: ProviderRegistry,
    queue: JobQueue,
    store: DocumentStore,
) -> IntelligenceRuntime:
    worker = IntelligenceWorker(queue, registry, store)
    return IntelligenceRuntime(
        registry=registry,
        queue=queue,
        store=store,
        worker=worker,
    )


def build_memory_runtime(*, registry: ProviderRegistry | None = None) -> IntelligenceRuntime:
    """Build an in-memory runtime suitable for unit/local tests."""
    return _build_runtime(
        registry or build_default_registry(),
        MemoryJobQueue(),
        MemoryDocumentStore(),
    )


def build_sqlite_runtime(
    path: str | Path,
    *,
    registry: ProviderRegistry | None = None,
) -> IntelligenceRuntime:
    """Build a durable runtime with SQLite queue and normalized storage."""
    resolved = Path(path)
    return _build_runtime(
        registry or build_default_registry(),
        SQLiteJobQueue(resolved),
        SQLiteDocumentStore(resolved),
    )
