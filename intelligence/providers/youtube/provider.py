"""YouTube intelligence provider backed by yt-dlp."""

from __future__ import annotations

import asyncio

from intelligence.core.models import IntelligenceDocument, ProviderHealth
from intelligence.errors.exceptions import NormalizationError, ProviderError
from intelligence.providers.base import IntelligenceProvider
from intelligence.providers.youtube.client import YouTubeClient
from intelligence.providers.youtube.normalizer import youtube_to_document


class YouTubeIntelligenceProvider(IntelligenceProvider):
    name = "youtube"

    def __init__(self, client: YouTubeClient | None = None, *, include_transcript: bool = True) -> None:
        self.client = client or YouTubeClient()
        self.include_transcript = include_transcript

    async def collect(self, query: str) -> list[IntelligenceDocument]:
        target = self.client.validate_youtube_url(query)
        metadata = await asyncio.to_thread(self.client.fetch_metadata, target)

        canonical_url = metadata.get("webpage_url")
        if not isinstance(canonical_url, str):
            raise NormalizationError("YouTube metadata is missing webpage_url")
        metadata = dict(metadata)
        metadata["webpage_url"] = self.client.validate_youtube_url(canonical_url)

        transcript = None
        if self.include_transcript:
            transcript = await asyncio.to_thread(self.client.fetch_transcript, target)
        return [youtube_to_document(metadata, transcript)]

    async def health(self) -> ProviderHealth:
        try:
            latency_ms = await asyncio.to_thread(self.client.health)
            return ProviderHealth(
                provider=self.name,
                healthy=True,
                latency_ms=latency_ms,
                details={"backend": "yt-dlp", "transcript_enabled": self.include_transcript},
            )
        except ProviderError:
            return ProviderHealth(
                provider=self.name,
                healthy=False,
                details={"backend": "yt-dlp", "error": "provider_unavailable"},
            )

    def normalize(self, document: IntelligenceDocument) -> IntelligenceDocument:
        if document.source != "youtube":
            raise NormalizationError("YouTube provider can only normalize youtube documents")
        return document
