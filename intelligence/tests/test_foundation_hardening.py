from __future__ import annotations

import json
import unittest
from datetime import datetime, timezone
from pathlib import Path

from intelligence.core.hashing import build_document_hash
from intelligence.core.models import IntelligenceDocument, ProviderHealth
from intelligence.health.doctor import run_health_check
from intelligence.providers.base import IntelligenceProvider
from intelligence.storage.memory_store import MemoryDocumentStore


class SecretFailingProvider(IntelligenceProvider):
    name = "secret-failing"

    async def collect(self, query: str) -> list[IntelligenceDocument]:
        return []

    async def health(self) -> ProviderHealth:
        raise RuntimeError("token=super-secret")


class FoundationHardeningTests(unittest.IsolatedAsyncioTestCase):
    async def test_doctor_redacts_provider_error_secrets(self) -> None:
        results = await run_health_check([SecretFailingProvider()])
        self.assertEqual(len(results), 1)
        self.assertFalse(results[0].healthy)
        message = results[0].details["error"]
        self.assertIn("[REDACTED]", message)
        self.assertNotIn("super-secret", message)

    async def test_schema_matches_python_author_and_optional_hash_fields(self) -> None:
        schema_path = Path(__file__).parents[1] / "schema" / "intelligence_document.json"
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        self.assertEqual(schema["properties"]["author"]["type"], ["string", "null"])
        self.assertEqual(schema["properties"]["raw_hash"]["type"], ["string", "null"])
        self.assertEqual(schema["properties"]["provider"]["type"], ["string", "null"])
        self.assertNotIn("raw_hash", schema["required"])
        self.assertNotIn("provider", schema["required"])

    async def test_memory_store_deduplicates_by_hash(self) -> None:
        store = MemoryDocumentStore()
        first = IntelligenceDocument(
            id="first",
            source="github",
            content="evidence",
            collected_at=datetime.now(timezone.utc),
        )
        first.raw_hash = build_document_hash(first)
        duplicate = IntelligenceDocument(
            id="second",
            source="github",
            content="evidence",
            collected_at=datetime.now(timezone.utc),
        )
        duplicate.raw_hash = build_document_hash(duplicate)
        self.assertEqual(first.raw_hash, duplicate.raw_hash)

        self.assertIs(store.save(first), first)
        self.assertIs(store.save(duplicate), first)
        self.assertEqual(len(store.list_all()), 1)
        assert first.raw_hash is not None
        self.assertIs(store.find_by_hash(first.raw_hash), first)


if __name__ == "__main__":
    unittest.main()
