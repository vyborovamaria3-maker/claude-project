"""HTTP client for public RSS and Atom feeds."""

from __future__ import annotations

import asyncio
import urllib.error
import urllib.request

from intelligence.errors.exceptions import ProviderError
from intelligence.security.urls import validate_outbound_public_http_url, validate_public_http_url


class _PublicOnlyRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        try:
            validated = validate_outbound_public_http_url(newurl)
        except ValueError as exc:
            raise urllib.error.URLError("RSS redirect target is not public") from exc
        return super().redirect_request(req, fp, code, msg, headers, validated)


class RSSClient:
    def __init__(self, *, timeout_seconds: float = 15.0, max_bytes: int = 1_000_000) -> None:
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be > 0")
        if max_bytes < 1:
            raise ValueError("max_bytes must be > 0")
        self.timeout_seconds = timeout_seconds
        self.max_bytes = max_bytes
        self._opener = urllib.request.build_opener(_PublicOnlyRedirectHandler())

    async def fetch(self, url: str) -> tuple[str, bytes]:
        # Resolve immediately before the connection, not only when accepting the
        # URL, so public-looking DNS names cannot resolve to internal services.
        target = await asyncio.to_thread(validate_outbound_public_http_url, url)
        payload = await asyncio.wait_for(
            asyncio.to_thread(self._fetch_sync, target),
            timeout=self.timeout_seconds + 1,
        )
        return target, payload

    async def health(self) -> int:
        # Health of RSS itself is feed-specific; this validates runtime readiness
        # without making a network call to an arbitrary third-party feed.
        started = asyncio.get_running_loop().time()
        validate_public_http_url("https://example.com/feed.xml")
        elapsed = asyncio.get_running_loop().time() - started
        return max(0, round(elapsed * 1000))

    def _fetch_sync(self, url: str) -> bytes:
        request = urllib.request.Request(
            url,
            headers={
                "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
                "User-Agent": "potapoff-intelligence/1.0",
            },
        )
        try:
            with self._opener.open(request, timeout=self.timeout_seconds) as response:
                payload = response.read(self.max_bytes + 1)
                if len(payload) > self.max_bytes:
                    raise ProviderError("RSS feed exceeds configured size limit")
                return payload
        except urllib.error.HTTPError as exc:
            raise ProviderError(f"RSS request failed with HTTP {exc.code}") from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            raise ProviderError("RSS request failed due to network or timeout error") from exc
