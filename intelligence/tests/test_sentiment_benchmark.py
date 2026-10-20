from __future__ import annotations

import hashlib
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path

from intelligence.nlp.benchmark import evaluate, run


REV = "a" * 40
REPOSITORIES = {
    "cryptobert": "ElKulako/cryptobert",
    "fintwitbert": "StephanAkkerman/FinTwitBERT-sentiment",
    "rubert": "seara/rubert-tiny2-russian-sentiment",
}
TASKS = {"cryptobert": "crypto_stance", "fintwitbert": "financial_stance",
         "rubert": "general_sentiment"}
LABELS = {"cryptobert": ("bearish", "neutral", "bullish"),
          "fintwitbert": ("neutral", "bullish", "bearish"),
          "rubert": ("neutral", "positive", "negative")}


def row(source, key, text, scores):
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return {
        "source": source, "source_id": key, "content_sha256": digest,
        "model_results": {name: {
            "model": REPOSITORIES[name], "revision": REV,
            "task": TASKS[name], "labels": dict(zip(LABELS[name], values, strict=True))
        } for name, values in scores.items()},
    }


def gold(r, labels):
    return {k: r[k] for k in ("source", "source_id", "content_sha256")} | {
        "labels": labels
    }


class SentimentBenchmarkTests(unittest.TestCase):
    def test_macro_f1_and_missing_predictions_never_hide_low_coverage(self):
        sample = [
            row("x", "x:tweet:1", "up", {"cryptobert": (.1, .1, .8),
                                         "fintwitbert": (.1, .8, .1)}),
            row("x", "x:tweet:2", "down", {"cryptobert": (.1, .1, .8)}),
            row("x", "x:tweet:3", "flat", {"cryptobert": (.1, .8, .1)}),
        ]
        gold_records = [
            gold(sample[0], {"cryptobert": "bullish", "fintwitbert": "bullish"}),
            gold(sample[1], {"cryptobert": "bearish"}),
            gold(sample[2], {"cryptobert": "neutral"}),
            gold(row("x", "x:tweet:4", "lost", {}), {"cryptobert": "neutral"}),
            gold(row("tg", "tg:message:-1001:5", "нет", {}), {"rubert": "positive"}),
        ]
        results = evaluate(sample, gold_records)
        crypto = next(r for r in results if r["model_key"] == "cryptobert")
        self.assertEqual(crypto["gold_count"], 4)
        self.assertEqual(crypto["matched"], 3)
        self.assertEqual(crypto["coverage"], 0.75)
        self.assertAlmostEqual(crypto["macro_f1_on_matched"], .555556, places=5)
        finance = next(r for r in results if r["model_key"] == "fintwitbert")
        self.assertEqual(finance["coverage"], 1.0)
        self.assertIn("bullish", finance["per_class"])
        russian = next(r for r in results if r["model_key"] == "rubert")
        self.assertEqual(russian["coverage"], 0)
        self.assertIsNone(russian["macro_f1_on_matched"])

    def test_duplicate_forged_revision_and_hash_do_not_generate_score(self):
        sample = row("x", "x:tweet:1", "example", {
            "cryptobert": (.1, .2, .7)
        })
        label = gold(sample, {"cryptobert": "bullish"})
        with self.assertRaisesRegex(ValueError, "duplicate gold"):
            evaluate([sample], [label, label])
        with self.assertRaisesRegex(ValueError, "duplicate prediction"):
            evaluate([sample, sample], [label])
        wrong = json.loads(json.dumps(sample))
        wrong["model_results"]["cryptobert"]["revision"] = "main"
        with self.assertRaisesRegex(ValueError, "revision"):
            evaluate([wrong], [label])
        unrelated = json.loads(json.dumps(sample))
        unrelated["content_sha256"] = "0" * 64
        report = evaluate([unrelated], [label])
        self.assertEqual(report[0]["coverage"], 0.0)

    def test_benchmark_cli_only_prints_aggregated_metrics(self):
        item = row("x", "x:tweet:1", "this message is private", {
            "cryptobert": (.1, .2, .7)
        })
        truth = gold(item, {"cryptobert": "bullish"})
        with tempfile.TemporaryDirectory() as temp:
            pred = Path(temp, "pred.jsonl")
            truth_path = Path(temp, "gold.jsonl")
            pred.write_text(json.dumps(item)+"\n", encoding="utf-8")
            truth_path.write_text(json.dumps(truth)+"\n", encoding="utf-8")
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                code = run(["--predictions", str(pred), "--gold", str(truth_path)])
            self.assertEqual(code, 0, err.getvalue())
            self.assertNotIn("private", out.getvalue())
            self.assertEqual(json.loads(out.getvalue())["model_key"], "cryptobert")


if __name__ == "__main__":
    unittest.main()
