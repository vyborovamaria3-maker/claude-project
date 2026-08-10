"""Registry for named intelligence providers."""

from __future__ import annotations

from collections.abc import Iterable

from intelligence.errors.exceptions import ProviderError
from intelligence.providers.base import IntelligenceProvider


class ProviderRegistry:
    def __init__(self, providers: Iterable[IntelligenceProvider] = ()) -> None:
        self._providers: dict[str, IntelligenceProvider] = {}
        for provider in providers:
            self.register(provider)

    def register(self, provider: IntelligenceProvider) -> None:
        name = provider.name.strip().lower()
        if not name or name == "unknown":
            raise ValueError("provider must define a stable non-empty name")
        if name in self._providers:
            raise ValueError(f"provider {name!r} is already registered")
        self._providers[name] = provider

    def get(self, name: str) -> IntelligenceProvider:
        normalized = name.strip().lower()
        provider = self._providers.get(normalized)
        if provider is None:
            raise ProviderError("requested intelligence provider is not registered")
        return provider

    def names(self) -> tuple[str, ...]:
        return tuple(sorted(self._providers))
