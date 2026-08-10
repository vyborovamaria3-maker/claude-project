"""RSS/Atom intelligence provider."""

from __future__ import annotations

from datetime import datetime, timezone
from urllib.parse import urljoin, urlsplit
from uuid import uuid4

from intelligence.core.hashing import build_document_hash
from intelligence.core.models import IntelligenceDocument, ProviderHealth
from intelligence.errors.exceptions import NormalizationError, ProviderError
from intelligence.providers.base import IntelligenceProvider
from intelligence.providers.rss.client import RSSClient
from intelligence.providers.rss.parser import FeedEntry, parse_feed
from intelligence.security.sanitizer import sanitize_text
from intelligence.security.urls import validate_public_http_url


class RSSIntelligenceProvider(IntelligenceProvider):
    name = "rss"

    def __init__(self, client: RSSClient | None = None, *, max_items: int = 50) -> None:
        if max_items < 1:
            raise ValueError("max_items must be > 0")
        self.client = client or RSSClient()
        self.max_items = max_items

    async def collect(self, query: str) -> list[IntelligenceDocument]:
        feed_url, payload = await self.client.fetch(query)
        entries = parse_feed(payload, max_items=self.max_items)
        return [self._entry_to_document(feed_url, entry) for entry in entries]

    async def health(self) -> ProviderHealth:
        try:
            latency_ms = await self.client.health()
            return ProviderHealth(
                provider=self.name,
                healthy=True,
                latency_ms=latency_ms,
                details={"backend": "stdlib-rss-atom"},
            )
        except ProviderError:
            return ProviderHealth(
                provider=self.name,
                healthy=False,
                details={"error": "provider_unavailable", "backend": "stdlib-rss-atom"},
            )

    def normalize(self, document: IntelligenceDocument) -> IntelligenceDocument:
        if document.source != "rss":
            raise NormalizationError("RSS provider can only normalize rss documents")
        return document

    @staticmethod
    def _entry_to_document(feed_url: str, entry: FeedEntry) -> IntelligenceDocument:
        resolved_link = None
        if entry.link:
            candidate = urljoin(feed_url, entry.link)
            try:
                resolved_link = validate_public_http_url(candidate)
            except ValueError:
                resolved_link = None

        hostname = (urlsplit(feed_url).hostname or "unknown").lower()
        title = sanitize_text(entry.title).strip() or "Untitled"
        summary = sanitize_text(entry.summary).strip()
        content = f"{title}\n\n{summary}".strip()
        document = IntelligenceDocument(
            id=str(uuid4()),
            source="rss",
            provider="stdlib-rss-atom",
            content=content,
            collected_at=datetime.now(timezone.utc),
            url=resolved_link or feed_url,
            author=hostname,
            published_at=entry.published_at,
            entities=["feed_entry", hostname],
            metrics={
                "feed_url": feed_url,
                "entry_id": sanitize_text(entry.entry_id).strip() if entry.entry_id else None,
                "title": title,
            },
        )
        document.raw_hash = build_document_hash(document)
        return document
