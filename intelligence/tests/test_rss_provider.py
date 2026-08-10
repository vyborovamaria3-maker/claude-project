from __future__ import annotations

import unittest
from datetime import datetime, timezone

from intelligence.core.models import IntelligenceDocument
from intelligence.errors.exceptions import NormalizationError, ProviderError
from intelligence.providers.rss.parser import parse_feed
from intelligence.providers.rss.provider import RSSIntelligenceProvider


RSS_SAMPLE = b"""<?xml version='1.0' encoding='UTF-8'?>
<rss version='2.0'>
  <channel>
    <title>Example Feed</title>
    <item>
      <title>Launch update</title>
      <link>https://example.com/posts/1#fragment</link>
      <guid>post-1</guid>
      <pubDate>Sun, 10 Aug 2026 03:00:00 GMT</pubDate>
      <description>token=secret-value Public update</description>
    </item>
    <item>
      <title>Second</title>
      <link>/posts/2</link>
      <description>Another update</description>
    </item>
  </channel>
</rss>
"""

ATOM_SAMPLE = b"""<?xml version='1.0' encoding='utf-8'?>
<feed xmlns='http://www.w3.org/2005/Atom'>
  <title>Atom Example</title>
  <entry>
    <title>Atom post</title>
    <id>tag:example.com,2026:1</id>
    <updated>2026-08-10T03:10:00Z</updated>
    <link href='https://example.com/atom/1' rel='alternate'/>
    <summary>Atom summary</summary>
  </entry>
</feed>
"""


class FakeRSSClient:
    def __init__(self, payload: bytes = RSS_SAMPLE) -> None:
        self.payload = payload

    async def fetch(self, url: str) -> tuple[str, bytes]:
        return "https://example.com/feed.xml", self.payload

    async def health(self) -> int:
        return 1


class FailingRSSClient(FakeRSSClient):
    async def health(self) -> int:
        raise ProviderError("cookie=must-not-leak")


class RSSParserTests(unittest.TestCase):
    def test_parses_rss_and_atom(self) -> None:
        rss_entries = parse_feed(RSS_SAMPLE)
        atom_entries = parse_feed(ATOM_SAMPLE)
        self.assertEqual(len(rss_entries), 2)
        self.assertEqual(rss_entries[0].title, "Launch update")
        self.assertIsNotNone(rss_entries[0].published_at)
        self.assertEqual(len(atom_entries), 1)
        self.assertEqual(atom_entries[0].title, "Atom post")
        self.assertEqual(atom_entries[0].link, "https://example.com/atom/1")

    def test_rejects_invalid_xml_and_unknown_root(self) -> None:
        with self.assertRaises(NormalizationError):
            parse_feed(b"<rss>")
        with self.assertRaises(NormalizationError):
            parse_feed(b"<html></html>")

    def test_rejects_doctype_and_entity_declarations(self) -> None:
        malicious = b"""<!DOCTYPE rss [<!ENTITY xxe SYSTEM 'file:///etc/passwd'>]>
        <rss><channel><item><title>&xxe;</title></item></channel></rss>"""
        with self.assertRaises(NormalizationError):
            parse_feed(malicious)

    def test_max_items_is_enforced(self) -> None:
        self.assertEqual(len(parse_feed(RSS_SAMPLE, max_items=1)), 1)
        with self.assertRaises(ValueError):
            parse_feed(RSS_SAMPLE, max_items=0)


class RSSProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_collect_normalizes_entries_and_redacts_secrets(self) -> None:
        provider = RSSIntelligenceProvider(client=FakeRSSClient())
        documents = await provider.collect("https://example.com/feed.xml")
        self.assertEqual(len(documents), 2)

        first = documents[0]
        self.assertEqual(first.source, "rss")
        self.assertEqual(first.provider, "stdlib-rss-atom")
        self.assertEqual(first.url, "https://example.com/posts/1")
        self.assertNotIn("secret-value", first.content)
        self.assertIn("[REDACTED]", first.content)
        self.assertEqual(len(first.raw_hash or ""), 64)

        second = documents[1]
        self.assertEqual(second.url, "https://example.com/posts/2")

    async def test_max_items_is_enforced_by_provider(self) -> None:
        provider = RSSIntelligenceProvider(client=FakeRSSClient(), max_items=1)
        documents = await provider.collect("https://example.com/feed.xml")
        self.assertEqual(len(documents), 1)

    async def test_health_never_exposes_raw_provider_error(self) -> None:
        health = await RSSIntelligenceProvider(client=FailingRSSClient()).health()
        self.assertFalse(health.healthy)
        self.assertEqual(health.details["error"], "provider_unavailable")
        self.assertNotIn("must-not-leak", str(health.details))

    async def test_normalize_rejects_wrong_source(self) -> None:
        provider = RSSIntelligenceProvider(client=FakeRSSClient())
        document = IntelligenceDocument(
            id="1",
            source="web",
            content="x",
            collected_at=datetime.now(timezone.utc),
        )
        with self.assertRaises(NormalizationError):
            provider.normalize(document)

    def test_invalid_max_items_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            RSSIntelligenceProvider(client=FakeRSSClient(), max_items=0)


if __name__ == "__main__":
    unittest.main()
