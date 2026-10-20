from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from intelligence.nlp.results_store import store_predictions
from intelligence.nlp.sentiment import SentimentEngine, SourceText
from intelligence.nlp.summary import summarize_as_of


class StubBackend:
    def predict(self, model, revision, texts):
        return [dict(zip(model.labels, (0.1, 0.2, 0.7), strict=True)) for _ in texts]


def dt(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


class AsOfSentimentTests(unittest.TestCase):
    def test_future_inference_cannot_leak_into_historical_as_of(self):
        observed = dt("2026-10-18T08:15:00Z")
        engine = SentimentEngine({
            "cryptobert": "a" * 40, "fintwitbert": "b" * 40,
            "rubert": "c" * 40,
        }, backend=StubBackend())
        x = SourceText("x", "x:tweet:81", "This crypto coin is bullish today", observed)
        tg = SourceText("tg", "tg:message:-100111:2", "Очень хорошие новости для токена!", observed)
        records = engine.analyze([x, tg])
        for record in records:
            record["inference_at"] = "2026-10-20T10:00:00.000Z"
        with tempfile.TemporaryDirectory() as root:
            path = Path(root, "derived.sqlite")
            self.assertEqual(store_predictions(path, records), 3)
            self.assertEqual(
                summarize_as_of(path, dt("2026-10-19T00:00:00Z")), [],
                "late inference cannot be used in historical trading decisions")
            latest = summarize_as_of(path, dt("2026-10-21T00:00:00Z"))
            self.assertEqual(len(latest), 3)
            crypto = next(x for x in latest if x["model_key"] == "cryptobert")
            ru = next(x for x in latest if x["model_key"] == "rubert")
            self.assertEqual(crypto["source"], "x")
            self.assertEqual(crypto["task"], "crypto_stance")
            self.assertIn("bullish", crypto["average_probabilities"])
            self.assertNotIn("positive", crypto["average_probabilities"])
            self.assertEqual(ru["task"], "general_sentiment")
            self.assertIn("positive", ru["average_probabilities"])
            self.assertNotIn("bullish", ru["average_probabilities"])
            only_x = summarize_as_of(path, dt("2026-10-21T00:00:00Z"), "x")
            self.assertEqual(len(only_x), 2)
            self.assertTrue(all(item["source"] == "x" for item in only_x))

    def test_read_only_summary_never_creates_missing_result_file(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root, "missing.sqlite")
            with self.assertRaisesRegex(ValueError, "existing absolute"):
                summarize_as_of(path, dt("2026-10-21T00:00:00Z"))
            self.assertFalse(path.exists())
        with self.assertRaisesRegex(ValueError, "timezone"):
            summarize_as_of(Path("/tmp/not-real"), datetime(2026, 10, 20))
        with self.assertRaisesRegex(ValueError, "source"):
            summarize_as_of(Path("/tmp/not-real"), dt("2026-10-21T00:00:00Z"), "blockchain")


if __name__ == "__main__":
    unittest.main()
