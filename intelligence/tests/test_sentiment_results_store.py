from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from intelligence.nlp.results_store import store_predictions
from intelligence.nlp.sentiment import SentimentEngine, SourceText


class ModelStub:
    def predict(self, model, revision, texts):
        return [dict(zip(model.labels, (0.1, 0.2, 0.7), strict=True)) for _ in texts]


def engine(*, new_rubert=False):
    return SentimentEngine(
        {"cryptobert": "a" * 40, "fintwitbert": "b" * 40,
         "rubert": ("d" if new_rubert else "c") * 40},
        backend=ModelStub(), batch_size=4,
    )


NOW = datetime(2026, 10, 18, 8, 15, tzinfo=timezone.utc)


class DurableSentimentTests(unittest.TestCase):
    def test_atomic_insert_dedup_and_versioned_reruns_no_raw_text(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp, "derived.sqlite")
            text = "Отличная новость для проекта токена!"
            observation = SourceText(
                "tg", "tg:message:-100222:10", text, NOW,
            )
            batch = engine().analyze([observation])
            self.assertEqual(store_predictions(path, batch), 1)
            self.assertEqual(store_predictions(path, batch), 0)
            with sqlite3.connect(path) as db:
                row = db.execute(
                    "SELECT model_key, model_revision, inference_at, probabilities_json "
                    "FROM sentiment_predictions"
                ).fetchone()
                self.assertEqual(row[0], "rubert")
                self.assertEqual(row[1], "c" * 40)
                self.assertEqual(row[2], batch[0]["inference_at"])
                self.assertAlmostEqual(json.loads(row[3])["negative"], 0.7)
                self.assertNotIn(text, "\n".join(str(x) for x in row))
                self.assertEqual(db.execute(
                    "SELECT count(*) FROM sentiment_predictions").fetchone()[0], 1)
            self.assertEqual(store_predictions(path, engine(new_rubert=True).analyze([observation])), 1)
            with sqlite3.connect(path) as db:
                self.assertEqual(db.execute(
                    "SELECT count(*) FROM sentiment_predictions").fetchone()[0], 2)

    def test_multi_model_results_saved_separately_and_conflict_does_not_rewrite(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp, "derived.sqlite")
            item = SourceText(
                "x", "x:tweet:881818", "This token looks absolutely bullish", NOW,
            )
            original = engine().analyze([item])[0]
            self.assertEqual(store_predictions(path, [original]), 2)
            tampered = json.loads(json.dumps(original))
            tampered["model_results"]["cryptobert"]["labels"] = {
                "bearish": 0.8, "neutral": 0.1, "bullish": 0.1
            }
            self.assertEqual(store_predictions(path, [tampered]), 0)
            with sqlite3.connect(path) as db:
                row = db.execute(
                    "SELECT probabilities_json FROM sentiment_predictions "
                    "WHERE model_key='cryptobert'"
                ).fetchone()[0]
                self.assertAlmostEqual(json.loads(row)["bullish"], 0.7)
                self.assertEqual(db.execute(
                    "SELECT count(*) FROM sentiment_predictions"
                ).fetchone()[0], 2)

    def test_reject_forged_record_and_roll_back_complete_batch(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp, "derived.sqlite")
            ok = engine().analyze([SourceText(
                "x", "x:tweet:881818", "This token looks bullish today", NOW
            )])[0]
            forged = json.loads(json.dumps(ok))
            forged["source"] = "blockchain"
            with self.assertRaisesRegex(ValueError, "result source"):
                store_predictions(path, [ok, forged])
            with sqlite3.connect(path) as db:
                self.assertEqual(db.execute(
                    "SELECT count(*) FROM sentiment_predictions").fetchone()[0], 0)
            bad_scores = json.loads(json.dumps(ok))
            bad_scores["model_results"]["cryptobert"]["labels"] = {
                "bearish": 20.0, "neutral": 0, "bullish": 0
            }
            with self.assertRaisesRegex(ValueError, "probabilities"):
                store_predictions(path, [bad_scores])

    def test_bounded_cli_can_persist_without_exporting_raw_message(self):
        import io
        from contextlib import redirect_stdout, redirect_stderr
        from intelligence.nlp import cli
        text = "The new crypto coin is bullish today"
        row = {"source": "x", "source_id": "x:tweet:9875",
               "text": text, "observed_at": "2026-10-18T08:15:00Z"}
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp, "sentiment.sqlite")
            source = io.StringIO(json.dumps(row) + "\n")
            with patch.object(cli.sys, "stdin", source):
                with patch.object(cli.SentimentEngine, "from_environment", return_value=engine()):
                    out, err = io.StringIO(), io.StringIO()
                    with redirect_stdout(out), redirect_stderr(err):
                        rc = cli.run(["--results-db", str(path), "--max-items", "2"])
            self.assertEqual(rc, 0, err.getvalue())
            self.assertNotIn(text, out.getvalue())
            self.assertEqual(len(out.getvalue().splitlines()), 1)
            with sqlite3.connect(path) as db:
                self.assertEqual(db.execute(
                    "SELECT count(*) FROM sentiment_predictions"
                ).fetchone()[0], 2)

    def test_explicit_path_does_not_mutate_collector_or_runtime_database(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp, "collector.sqlite")
            with sqlite3.connect(path) as db:
                db.execute("CREATE TABLE tg_messages (id INTEGER PRIMARY KEY)")
            rows = engine().analyze([SourceText(
                "tg", "tg:message:-100222:10", "Очень хороший рынок сегодня", NOW
            )])
            with self.assertRaisesRegex(ValueError, "separate"):
                store_predictions(path, rows)
            with sqlite3.connect(path) as db:
                self.assertEqual(db.execute(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name='sentiment_predictions'"
                ).fetchone()[0], 0)
            with self.assertRaisesRegex(ValueError, "absolute"):
                store_predictions(Path("relative-results.sqlite"), rows)
            with self.assertRaisesRegex(ValueError, "real SQLite"):
                store_predictions(Path(":memory:"), rows)


if __name__ == "__main__":
    unittest.main()
