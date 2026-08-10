"""Jina Reader client for public web intelligence."""

from __future__ import annotations

import asyncio
import ipaddress
import urllib.error
import urllib.parse
import urllib.request

from intelligence.errors.exceptions import ProviderError


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
        # Lightweight, deterministic public target; response content is ignored.
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
        value = url.strip()
        parsed = urllib.parse.urlsplit(value)
        if parsed.scheme not in {"http", "https"}:
            raise ValueError("Web provider only accepts http/https URLs")
        if not parsed.hostname:
            raise ValueError("Web URL must include a hostname")
        if parsed.username is not None or parsed.password is not None:
            raise ValueError("Web URL must not contain credentials")

        hostname = parsed.hostname.rstrip(".").lower()
        if hostname in {"localhost", "localhost.localdomain"} or hostname.endswith(".localhost"):
            raise ValueError("Localhost URLs are not allowed")

        try:
            address = ipaddress.ip_address(hostname)
        except ValueError:
            address = None
        if address is not None and not address.is_global:
            raise ValueError("Private, loopback and link-local IP URLs are not allowed")

        # Drop fragments because they do not affect the fetched resource and only
        # create duplicate evidence hashes.
        return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path or "/", parsed.query, ""))
