from __future__ import annotations

import unittest

from intelligence.core.models import IntelligenceDocument
from intelligence.errors.exceptions import NormalizationError, ProviderError
from intelligence.providers.web.client import JinaReaderClient
from intelligence.providers.web.provider import WebIntelligenceProvider


class FakeJinaClient:
    def __init__(self, content: str = "# Example\nTOKEN=super-secret\nPublic body") -> None:
        self.content = content

    def validate_public_url(self, url: str) -> str:
        return JinaReaderClient.validate_public_url(url)

    async def read(self, url: str) -> str:
        return self.content

    async def health(self) -> int:
        return 23


class FailingJinaClient(FakeJinaClient):
    async def health(self) -> int:
        raise ProviderError("TOKEN=must-never-leak")


class WebClientValidationTests(unittest.TestCase):
    def test_accepts_public_https_url_and_drops_fragment(self) -> None:
        result = JinaReaderClient.validate_public_url("https://example.com/docs?a=1#section")
        self.assertEqual(result, "https://example.com/docs?a=1")

    def test_rejects_unsupported_scheme(self) -> None:
        with self.assertRaises(ValueError):
            JinaReaderClient.validate_public_url("file:///etc/passwd")

    def test_rejects_url_credentials(self) -> None:
        with self.assertRaises(ValueError):
            JinaReaderClient.validate_public_url("https://user:pass@example.com/")

    def test_rejects_localhost_and_private_literal_ips(self) -> None:
        for url in (
            "http://localhost/",
            "http://127.0.0.1/",
            "http://10.0.0.1/",
            "http://169.254.169.254/latest/meta-data/",
            "http://[::1]/",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                JinaReaderClient.validate_public_url(url)

    def test_client_configuration_is_validated(self) -> None:
        with self.assertRaises(ValueError):
            JinaReaderClient(timeout_seconds=0)
        with self.assertRaises(ValueError):
            JinaReaderClient(max_bytes=0)


class WebProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_collect_sanitizes_content_and_builds_hash(self) -> None:
        provider = WebIntelligenceProvider(client=FakeJinaClient())
        documents = await provider.collect("https://example.com/project#overview")

        self.assertEqual(len(documents), 1)
        document = documents[0]
        self.assertEqual(document.source, "web")
        self.assertEqual(document.provider, "jina-reader")
        self.assertEqual(document.url, "https://example.com/project")
        self.assertEqual(document.author, "example.com")
        self.assertNotIn("super-secret", document.content)
        self.assertIn("[REDACTED]", document.content)
        self.assertEqual(len(document.raw_hash or ""), 64)
        self.assertEqual(document.metrics["characters"], len(document.content))

    async def test_health_reports_backend_without_raw_error(self) -> None:
        provider = WebIntelligenceProvider(client=FakeJinaClient())
        health = await provider.health()
        self.assertTrue(health.healthy)
        self.assertEqual(health.latency_ms, 23)
        self.assertEqual(health.details["backend"], "jina-reader")

        degraded = await WebIntelligenceProvider(client=FailingJinaClient()).health()
        self.assertFalse(degraded.healthy)
        self.assertEqual(degraded.details["error"], "provider_unavailable")
        self.assertNotIn("must-never-leak", str(degraded.details))

    async def test_normalize_rejects_other_source(self) -> None:
        provider = WebIntelligenceProvider(client=FakeJinaClient())
        document = IntelligenceDocument(
            id="1",
            source="github",
            content="x",
            collected_at=__import__("datetime").datetime.now(__import__("datetime").timezone.utc),
        )
        with self.assertRaises(NormalizationError):
            provider.normalize(document)


if __name__ == "__main__":
    unittest.main()
