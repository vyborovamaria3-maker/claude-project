from __future__ import annotations

import unittest
from datetime import datetime, timezone

from intelligence.core.models import IntelligenceDocument
from intelligence.errors.exceptions import NormalizationError, ProviderError
from intelligence.providers.youtube.client import YouTubeClient, _vtt_to_text
from intelligence.providers.youtube.normalizer import youtube_to_document
from intelligence.providers.youtube.provider import YouTubeIntelligenceProvider


class FakeYouTubeClient:
    def __init__(self, *, canonical_url: str = "https://www.youtube.com/watch?v=abc123") -> None:
        self.canonical_url = canonical_url
        self.metadata_calls = 0
        self.transcript_calls = 0

    def validate_youtube_url(self, url: str) -> str:
        return YouTubeClient.validate_youtube_url(url)

    def fetch_metadata(self, url: str):
        self.metadata_calls += 1
        return {
            "id": "abc123",
            "title": "Launch token=title-secret",
            "webpage_url": self.canonical_url,
            "channel": "Example Channel",
            "channel_id": "UC123",
            "description": "Authorization Bearer description-secret Public description",
            "duration": 123,
            "view_count": 1000,
            "like_count": 100,
            "comment_count": 10,
            "timestamp": 1786330800,
        }

    def fetch_transcript(self, url: str):
        self.transcript_calls += 1
        return "cookie=session-secret\nPublic transcript"

    def health(self) -> int:
        return 5


class FailingYouTubeClient(FakeYouTubeClient):
    def health(self) -> int:
        raise ProviderError("token=must-not-leak")


class YouTubeClientValidationTests(unittest.TestCase):
    def test_accepts_youtube_hosts_and_rejects_others(self) -> None:
        accepted = (
            "https://www.youtube.com/watch?v=abc123#fragment",
            "https://youtu.be/abc123",
            "https://m.youtube.com/watch?v=abc123",
            "https://music.youtube.com/watch?v=abc123",
        )
        for url in accepted:
            with self.subTest(url=url):
                normalized = YouTubeClient.validate_youtube_url(url)
                self.assertNotIn("#", normalized)

        for url in (
            "https://example.com/watch?v=abc123",
            "file:///tmp/video",
            "https://user:pass@youtube.com/watch?v=abc123",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                YouTubeClient.validate_youtube_url(url)

    def test_client_configuration_validation(self) -> None:
        with self.assertRaises(ValueError):
            YouTubeClient(timeout_seconds=0)
        with self.assertRaises(ValueError):
            YouTubeClient(max_output_bytes=0)
        with self.assertRaises(ValueError):
            YouTubeClient(executable=" ")
        with self.assertRaises(ValueError):
            YouTubeClient(subtitle_languages=())

    def test_vtt_parser_removes_cues_tags_and_duplicates(self) -> None:
        value = """WEBVTT

00:00:00.000 --> 00:00:01.000 align:start
<c>Hello</c>
00:00:01.000 --> 00:00:02.000
<c>Hello</c>
00:00:02.000 --> 00:00:03.000
World
"""
        self.assertEqual(_vtt_to_text(value), "Hello\nWorld")


class YouTubeProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_collect_normalizes_metadata_transcript_and_redacts_secrets(self) -> None:
        client = FakeYouTubeClient()
        provider = YouTubeIntelligenceProvider(client=client)
        documents = await provider.collect("https://youtu.be/abc123#fragment")

        self.assertEqual(len(documents), 1)
        document = documents[0]
        self.assertEqual(document.source, "youtube")
        self.assertEqual(document.provider, "yt-dlp")
        self.assertEqual(document.url, "https://www.youtube.com/watch?v=abc123")
        self.assertEqual(document.author, "Example Channel")
        self.assertEqual(document.metrics["duration_seconds"], 123)
        self.assertTrue(document.metrics["has_transcript"])
        self.assertNotIn("title-secret", document.content)
        self.assertNotIn("description-secret", document.content)
        self.assertNotIn("session-secret", document.content)
        self.assertGreaterEqual(document.content.count("[REDACTED]"), 3)
        self.assertEqual(len(document.raw_hash or ""), 64)
        self.assertEqual(client.metadata_calls, 1)
        self.assertEqual(client.transcript_calls, 1)

    async def test_transcript_can_be_disabled(self) -> None:
        client = FakeYouTubeClient()
        provider = YouTubeIntelligenceProvider(client=client, include_transcript=False)
        document = (await provider.collect("https://youtu.be/abc123"))[0]
        self.assertFalse(document.metrics["has_transcript"])
        self.assertEqual(client.transcript_calls, 0)

    async def test_rejects_untrusted_canonical_url_from_metadata(self) -> None:
        provider = YouTubeIntelligenceProvider(
            client=FakeYouTubeClient(canonical_url="https://evil.example/video")
        )
        with self.assertRaises(ValueError):
            await provider.collect("https://youtu.be/abc123")

    async def test_health_does_not_expose_raw_error(self) -> None:
        healthy = await YouTubeIntelligenceProvider(client=FakeYouTubeClient()).health()
        self.assertTrue(healthy.healthy)
        self.assertEqual(healthy.details["backend"], "yt-dlp")

        failed = await YouTubeIntelligenceProvider(client=FailingYouTubeClient()).health()
        self.assertFalse(failed.healthy)
        self.assertEqual(failed.details["error"], "provider_unavailable")
        self.assertNotIn("must-not-leak", str(failed.details))

    async def test_normalize_rejects_wrong_source(self) -> None:
        provider = YouTubeIntelligenceProvider(client=FakeYouTubeClient())
        document = IntelligenceDocument(
            id="1",
            source="web",
            content="x",
            collected_at=datetime.now(timezone.utc),
        )
        with self.assertRaises(NormalizationError):
            provider.normalize(document)


class YouTubeNormalizerTests(unittest.TestCase):
    def test_missing_required_metadata_is_rejected(self) -> None:
        with self.assertRaises(NormalizationError):
            youtube_to_document({"id": "x", "webpage_url": "https://youtu.be/x"})

    def test_negative_metrics_are_clamped(self) -> None:
        document = youtube_to_document(
            {
                "id": "abc123",
                "title": "Example",
                "webpage_url": "https://youtu.be/abc123",
                "duration": -1,
                "view_count": -5,
            }
        )
        self.assertEqual(document.metrics["duration_seconds"], 0)
        self.assertEqual(document.metrics["view_count"], 0)


if __name__ == "__main__":
    unittest.main()
