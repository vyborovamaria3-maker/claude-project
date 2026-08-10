from __future__ import annotations

from intelligence.core.models import ProviderHealth
from intelligence.providers.base import IntelligenceProvider
from intelligence.security.sanitizer import sanitize_text


async def run_health_check(providers: list[IntelligenceProvider]) -> list[ProviderHealth]:
    results: list[ProviderHealth] = []
    for provider in providers:
        try:
            results.append(await provider.health())
        except Exception as exc:  # health aggregation must isolate unexpected provider failures
            error = sanitize_text(str(exc))
            results.append(
                ProviderHealth(
                    provider=getattr(provider, "name", "unknown"),
                    healthy=False,
                    details={"error": error or exc.__class__.__name__},
                )
            )
    return results
