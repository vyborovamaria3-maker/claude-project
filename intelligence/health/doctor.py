from __future__ import annotations

import asyncio
from collections.abc import Iterable

from intelligence.core.models import ProviderHealth
from intelligence.providers.base import IntelligenceProvider
from intelligence.providers.registry import ProviderRegistry
from intelligence.security.sanitizer import sanitize_text


async def _safe_health(provider: IntelligenceProvider) -> ProviderHealth:
    try:
        return await provider.health()
    except Exception as exc:  # health aggregation must isolate unexpected provider failures
        error = sanitize_text(str(exc)).strip()
        if len(error) > 300:
            error = error[:297] + "..."
        return ProviderHealth(
            provider=getattr(provider, "name", "unknown"),
            healthy=False,
            details={"error": error or exc.__class__.__name__},
        )


async def run_health_check(providers: Iterable[IntelligenceProvider]) -> list[ProviderHealth]:
    """Run provider checks concurrently while preserving input order."""
    provider_list = list(providers)
    if not provider_list:
        return []
    return list(await asyncio.gather(*(_safe_health(provider) for provider in provider_list)))


async def run_registry_health_check(registry: ProviderRegistry) -> list[ProviderHealth]:
    """Run health checks for every provider registered in stable name order."""
    return await run_health_check(registry.providers())


def summarize_health(results: Iterable[ProviderHealth]) -> dict[str, object]:
    """Return a small serializable summary for APIs and Control Center."""
    items = list(results)
    healthy = sum(1 for item in items if item.healthy)
    return {
        "healthy": healthy,
        "degraded": len(items) - healthy,
        "total": len(items),
        "all_healthy": bool(items) and healthy == len(items),
        "providers": [
            {
                "name": item.provider,
                "healthy": item.healthy,
                "latency_ms": item.latency_ms,
                "details": dict(item.details),
            }
            for item in items
        ],
    }
