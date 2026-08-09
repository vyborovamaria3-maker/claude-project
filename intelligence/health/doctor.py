from intelligence.core.models import ProviderHealth


async def run_health_check(providers: list) -> list[ProviderHealth]:
    results: list[ProviderHealth] = []
    for provider in providers:
        try:
            results.append(await provider.health())
        except Exception as exc:
            results.append(
                ProviderHealth(
                    provider=getattr(provider, "name", "unknown"),
                    healthy=False,
                    details={"error": str(exc)},
                )
            )
    return results
