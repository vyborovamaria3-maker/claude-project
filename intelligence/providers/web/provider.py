"""Public web intelligence provider backed by Jina Reader."""

from __future__ import annotations

from intelligence.core.models import IntelligenceDocument, ProviderHealth
from intelligence.errors.exceptions import NormalizationError, ProviderError
from intelligence.providers.base import IntelligenceProvider
from intelligence.providers.web.client import JinaReaderClient
from intelligence.providers.web.normalizer import web_content_to_document


class WebIntelligenceProvider(IntelligenceProvider):
    name = "web"

    def __init__(self, client: JinaReaderClient | None = None) -> None:
        self.client = client or JinaReaderClient()

    async def collect(self, query: str) -> list[IntelligenceDocument]:
        target = self.client.validate_public_url(query)
        content = await self.client.read(target)
        return [web_content_to_document(target, content)]

    async def health(self) -> ProviderHealth:
        try:
            latency_ms = await self.client.health()
            return ProviderHealth(
                provider=self.name,
                healthy=True,
                latency_ms=latency_ms,
                details={"backend": "jina-reader"},
            )
        except ProviderError:
            return ProviderHealth(
                provider=self.name,
                healthy=False,
                details={"error": "provider_unavailable", "backend": "jina-reader"},
            )

    def normalize(self, document: IntelligenceDocument) -> IntelligenceDocument:
        if document.source != "web":
            raise NormalizationError("Web provider can only normalize web documents")
        return document
