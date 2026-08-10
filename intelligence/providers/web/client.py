"""Jina Reader client for public web intelligence."""

from __future__ import annotations

import asyncio
import urllib.error
import urllib.request

from intelligence.errors.exceptions import ProviderError
from intelligence.security.urls import validate_public_http_url


class JinaReaderClient:
    reader_base = "https://r.jina.ai/"

    def __init__(self, *, timeout_seconds: float = 20.0, max_bytes: int = 2_000_000) -> None:
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be > 0")
        if max_bytes < 1:
            raise ValueError("max_bytes must be > 0")
        self.timeout_seconds = timeout_seconds
        self.max_bytes = max_bytes

    async def read(self, url: str) -> str:
        target = self.validate_public_url(url)
        return await asyncio.wait_for(
            asyncio.to_thread(self._read_sync, target),
            timeout=self.timeout_seconds + 1,
        )

    async def health(self) -> int:
        started = asyncio.get_running_loop().time()
        await self.read("https://example.com")
        elapsed = asyncio.get_running_loop().time() - started
        return max(0, round(elapsed * 1000))

    def _read_sync(self, url: str) -> str:
        request = urllib.request.Request(
            f"{self.reader_base}{url}",
            headers={
                "Accept": "text/plain, text/markdown;q=0.9, */*;q=0.1",
                "User-Agent": "potapoff-intelligence/1.0",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                payload = response.read(self.max_bytes + 1)
                if len(payload) > self.max_bytes:
                    raise ProviderError("Web document exceeds configured size limit")
                return payload.decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            raise ProviderError(f"Jina Reader request failed with HTTP {exc.code}") from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            raise ProviderError("Jina Reader request failed due to network or timeout error") from exc

    @staticmethod
    def validate_public_url(url: str) -> str:
        return validate_public_http_url(url)
