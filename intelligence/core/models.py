from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


@dataclass(slots=True)
class IntelligenceDocument:
    id: str
    source: str
    content: str
    collected_at: datetime
    url: str | None = None
    author: str | None = None
    provider: str | None = None
    published_at: datetime | None = None
    entities: list[str] = field(default_factory=list)
    metrics: dict[str, Any] = field(default_factory=dict)
    raw_hash: str | None = None


@dataclass(slots=True)
class ProviderHealth:
    provider: str
    healthy: bool
    latency_ms: int | None = None
    details: dict[str, Any] = field(default_factory=dict)
