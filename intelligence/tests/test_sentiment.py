from __future__ import annotations

import hashlib
import json
import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from types import SimpleNamespace
import sys

from intelligence.bootstrap import build_memory_runtime
from intelligence.core.models import IntelligenceDocument, ProviderHealth
from intelligence.nlp.sentiment import (
    CRYPTO, FINTWIT, RUBERT, SCHEMA_VERSION, SentimentEngine, LocalTransformersBackend,
    SourceText, detect_language, route_models,
)
from intelligence.providers.base import IntelligenceProvider
from intelligence.providers.registry import ProviderRegistry
from intelligence.storage.memory_store import MemoryDocumentStore
from intelligence.worker.jobs import IntelligenceWorker
from intelligence.worker.queue import MemoryJobQueue


REV = "a" * 40
NOW = datetime(2026, 10, 20, 8, 45, tzinfo=timezone.utc)


class MockModels:
    def __init__(self):
        self.calls = []

    def predict(self, model, revision, texts):
        self.calls.append((model.key, revision, tuple(texts)))
        return [{label: weight for label, weight in zip(model.labels, (0.1, 0.2, 0.7))} for _ in texts]


def engine(backend=None, batch_size=8):
    return SentimentEngine(
        {"cryptobert": REV, "fintwitbert": "b" * 40, "rubert": "c" * 40},
        backend=backend or MockModels(), batch_size=batch_size,
    )


def x(text, ident="x:tweet:123"):
    return SourceText(source="x", source_id=ident, text=text, observed_at=NOW)


def tg(text, ident="tg:message:-100123:55"):
    return SourceText(source="tg", source_id=ident, text=text, observed_at=NOW)


class SentimentTests(unittest.TestCase):
    def test_expected_model_domains_and_label_order(self):
        self.assertEqual(CRYPTO.labels, ("bearish", "neutral", "bullish"))
        self.assertEqual(FINTWIT.labels, ("neutral", "bullish", "bearish"))
        self.assertEqual(RUBERT.labels, ("neutral", "positive", "negative"))
        self.assertEqual(route_models("x", "en"), ("cryptobert", "fintwitbert"))
        self.assertEqual(route_models("tg", "ru"), ("rubert",))
        self.assertEqual(route_models("tg", "en"), ("cryptobert",))
        self.assertEqual(route_models("x", "ru"), ())

    def test_language_detection_does_not_guess_on_urls_tickers_and_mixed(self):
        self.assertEqual(detect_language("Bitcoin is absolutely bullish today!"), "en")
        self.assertEqual(detect_language("Это прекрасная новость для рынка!"), "ru")
        self.assertEqual(detect_language("Это прекрасная новость для рынка! $SOL https://example.org/a"), "ru")
        self.assertEqual(detect_language("Рынок готов bullish rally today"), "mixed")
        self.assertEqual(detect_language("$SOL 🚀🚀"), "unknown")

    def test_multisource_routing_and_provenance_without_text_leakage(self):
        backend = MockModels()
        samples = [
            x("The Solana market is moving higher!"),
            tg("Сегодня рынок растёт уверенно!"),
            tg("Crypto market sentiment is bullish today!"),
            x("Покупаю и держу этот токен."),
        ]
        result = engine(backend).analyze(samples)
        self.assertEqual([list(row["model_results"]) for row in result], [
            ["cryptobert", "fintwitbert"], ["rubert"], ["cryptobert"], [],
        ])
        self.assertEqual(result[0]["model_results"]["cryptobert"]["task"], "crypto_stance")
        self.assertEqual(result[1]["model_results"]["rubert"]["task"], "general_sentiment")
        self.assertEqual(result[1]["model_results"]["rubert"]["labels"]["negative"], .7)
        self.assertEqual(result[0]["observed_at"], "2026-10-20T08:45:00.000Z")
        self.assertTrue(result[0]["inference_at"].endswith("Z"))
        self.assertEqual(result[0]["source_id"], "x:tweet:123")
        self.assertEqual(result[0]["content_sha256"], hashlib.sha256(samples[0].text.encode()).hexdigest())
        self.assertNotIn(samples[0].text, json.dumps(result))
        self.assertNotIn(samples[1].text, json.dumps(result))
        self.assertEqual(result[3]["status"], "unsupported_language")

    def test_cashtags_are_retained_for_crypto_model_inference(self):
        backend = MockModels()
        engine(backend).analyze([x("The $SOL memecoin is extremely bullish!")])
        self.assertIn("$SOL", backend.calls[0][2][0])

    def test_memory_policy_limits_model_residency_to_one_by_default(self):
        b = LocalTransformersBackend()
        self.assertEqual(b.device, "cpu")
        self.assertEqual(b.max_loaded_models, 1)
        first = (CRYPTO.key, "a" * 40)
        second = (FINTWIT.key, "b" * 40)
        b._loaded[first] = (object(), object())
        b._make_room()
        self.assertEqual(b._loaded, {}, "old model must be evicted before allocating next")
        b._loaded[second] = (object(), object())
        b.unload_all()
        self.assertEqual(b._loaded, {})
        for value in (0, -1, 4, 1.5, True):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "max_loaded_models"):
                LocalTransformersBackend(max_loaded_models=value)

    def test_cuda_eviction_releases_cached_tensors_with_fake_torch(self):
        hits = []
        fake_torch = SimpleNamespace(
            cuda=SimpleNamespace(is_available=lambda: True,
                                 empty_cache=lambda: hits.append("empty_cache"))
        )
        b = LocalTransformersBackend(device="cuda:0")
        b._loaded[("cryptobert", "a" * 40)] = (object(), object())
        with patch.dict(sys.modules, {"torch": fake_torch}):
            b._make_room()
            b._loaded[("rubert", "c" * 40)] = (object(), object())
            b.unload_all()
        self.assertEqual(len(hits), 2)
        self.assertFalse(b._loaded)

    def test_environment_policy_is_opt_in_and_bounded(self):
        env = {
            "SENTIMENT_CRYPTOBERT_REVISION": "a" * 40,
            "SENTIMENT_FINTWITBERT_REVISION": "b" * 40,
            "SENTIMENT_RUBERT_REVISION": "c" * 40,
            "SENTIMENT_MAX_LOADED_MODELS": "2",
            "SENTIMENT_DEVICE": "cpu",
        }
        with patch.dict(os.environ, env):
            b = SentimentEngine.from_environment().backend
            self.assertIsInstance(b, LocalTransformersBackend)
            self.assertEqual(b.max_loaded_models, 2)
        with patch.dict(os.environ, {**env, "SENTIMENT_MAX_LOADED_MODELS": "50"}):
            with self.assertRaises(ValueError):
                SentimentEngine.from_environment()

    def test_bounded_batching_and_exact_revision(self):
        backend = MockModels()
        samples = [x("This coin will rally hard tomorrow", f"x:tweet:{n}") for n in range(1, 6)]
        result = engine(backend, batch_size=2).analyze(samples)
        self.assertEqual(len(result), 5)
        self.assertEqual([a[0] for a in backend.calls], ["cryptobert"] * 3 + ["fintwitbert"] * 3)
        self.assertEqual([len(c[2]) for c in backend.calls], [2, 2, 1, 2, 2, 1])
        self.assertEqual(backend.calls[0][1], REV)
        self.assertEqual(result[0]["schema_version"], SCHEMA_VERSION)

    def test_fails_on_unpinned_invalid_models_or_probability_shape(self):
        with self.assertRaisesRegex(ValueError, "40-hex"):
            SentimentEngine({"cryptobert": "main", "fintwitbert": REV, "rubert": REV})
        with self.assertRaises(ValueError):
            engine().analyze([x("text", "x:tweet:@alice")])
        with self.assertRaises(ValueError):
            engine().analyze([tg("text", "tg:message:55")])
        with self.assertRaises(ValueError):
            engine().analyze([x("This is bullish", "x:tweet:0")])
        with self.assertRaises(ValueError):
            engine().analyze([x("This is bullish", "x:tweet:33")]*1001)
        self.assertEqual(engine().analyze([x("🚀", "x:tweet:123")])[0]["status"], "unsupported_language")
        with self.assertRaises(ValueError):
            engine().analyze([SourceText("x", "x:tweet:123", "good", NOW,
                                        occurred_at=NOW + timedelta(days=1))])
        class BadBackend:
            def predict(self, model, revision, texts):
                return [{label: .9 for label in model.labels} for _ in texts]
        with self.assertRaisesRegex(ValueError, "sum to one"):
            engine(BadBackend()).analyze([x("Crypto sentiment is strongly bullish")])

    def test_observation_time_requires_timezone(self):
        with self.assertRaisesRegex(ValueError, "timezone"):
            engine().analyze([SourceText("x", "x:tweet:123", "Bullish coin",
                                         datetime(2026, 10, 20))])

    def test_enrich_document_uses_existing_metrics_and_preserves_raw_content(self):
        e = engine()
        original = IntelligenceDocument(
            id="tg:message:-100123:55", source="tg",
            content="Это действительно отличная инвестиция!",
            collected_at=NOW, metrics={"views": 11},
        )
        enriched = e.enrich_document(original)
        self.assertEqual(enriched.content, original.content)
        self.assertEqual(enriched.metrics["views"], 11)
        self.assertEqual(enriched.metrics[SCHEMA_VERSION]["model_results"]["rubert"]["revision"], "c"*40)
        other = IntelligenceDocument(id="github-doc", source="github",
                                      content="sample", collected_at=NOW)
        self.assertIs(e.enrich_document(other), other)
        self.assertEqual(other.metrics, {})


class FakeTGProvider(IntelligenceProvider):
    name = "tg-test"

    async def collect(self, query):
        return [IntelligenceDocument(
            id="tg:message:-100123:55", source="tg",
            content="Отличная новость для сообщества!",
            collected_at=NOW,
        )]

    async def health(self):
        return ProviderHealth(provider="tg-test", healthy=True)


class WorkerIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_opt_in_enriches_before_persisting(self):
        queue, store = MemoryJobQueue(), MemoryDocumentStore()
        worker = IntelligenceWorker(queue, ProviderRegistry([FakeTGProvider()]),
                                    store, sentiment=engine())
        job = queue.submit({"provider": "tg-test", "query": "unused"})
        result = await worker.run(job)
        self.assertEqual(result.status.value, "completed")
        self.assertEqual(len(result.result_document_ids), 1)
        stored = store.get("tg:message:-100123:55")
        self.assertIn(SCHEMA_VERSION, stored.metrics)
        self.assertIn("rubert", stored.metrics[SCHEMA_VERSION]["model_results"])

    async def test_default_worker_never_uses_sentiment(self):
        queue, store = MemoryJobQueue(), MemoryDocumentStore()
        worker = IntelligenceWorker(queue, ProviderRegistry([FakeTGProvider()]), store)
        result = await worker.run(queue.submit({"provider": "tg-test", "query": "unused"}))
        self.assertEqual(result.status.value, "completed")
        self.assertNotIn(SCHEMA_VERSION, store.get("tg:message:-100123:55").metrics)

    async def test_runtime_bootstrap_remains_disabled_by_default(self):
        with patch.dict(os.environ, {"INTELLIGENCE_SENTIMENT_ENABLED": "false"}):
            runtime = build_memory_runtime(registry=ProviderRegistry([FakeTGProvider()]))
            self.assertIsNone(runtime.worker.sentiment)

if __name__ == "__main__":
    unittest.main()
