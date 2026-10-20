from __future__ import annotations

import io
import json
import os
import unittest
from contextlib import redirect_stdout, redirect_stderr
from datetime import datetime, timezone
from unittest.mock import patch

from intelligence.nlp.sources import read_collector_texts
from intelligence.nlp.sentiment import SentimentEngine, SourceText


TS = datetime(2026, 10, 20, 12, tzinfo=timezone.utc)


class FakeCursor:
    def __init__(self, rows):
        self.rows = rows
        self.statements = []
    def __enter__(self):
        return self
    def __exit__(self, *args):
        return False
    def execute(self, sql, params=None):
        self.statements.append((sql, params))
    def fetchall(self):
        return self.rows


class FakeConnection:
    def __init__(self, rows):
        self.db_cursor = FakeCursor(rows)
        self.connected = False
    def __enter__(self):
        self.connected = True
        return self
    def __exit__(self, *args):
        return False
    def cursor(self):
        return self.db_cursor


class SentimentSourcesTests(unittest.TestCase):
    def test_x_query_uses_read_only_and_stable_canonical_id(self):
        conn = FakeConnection([("123", "Crypto markets look bullish today", TS, TS)])
        calls = []
        def connect(dsn, **kwargs):
            calls.append((dsn, kwargs))
            return conn
        result = read_collector_texts("x", dsn="fixture", limit=3, connect=connect)
        self.assertEqual(result[0].source_id, "x:tweet:123")
        self.assertEqual(result[0].observed_at, TS)
        self.assertEqual(len(conn.db_cursor.statements), 2)
        self.assertEqual(conn.db_cursor.statements[0], ("SET TRANSACTION READ ONLY", None))
        query, args = conn.db_cursor.statements[1]
        self.assertIn("FROM twitter_tweets", query)
        self.assertEqual(args, (3,))
        self.assertNotIn("UPDATE", query.upper())
        self.assertEqual(calls[0][1]["connect_timeout"], 5)

    def test_tg_uses_peer_id_not_database_surrogate_and_skips_deleted(self):
        conn = FakeConnection([("-100123", 22, "Сегодня всё хорошо", TS, TS)])
        result = read_collector_texts("tg", dsn="fixture", connect=lambda *a, **k: conn)
        self.assertEqual(result[0].source_id, "tg:message:-100123:22")
        query, _ = conn.db_cursor.statements[1]
        self.assertIn("m.deleted_at IS NULL", query)
        self.assertIn("s.peer_id", query)
        self.assertIn("JOIN tg_sources", query)
        self.assertNotIn("UPDATE", query.upper())

    def test_no_query_run_for_invalid_limit_or_source(self):
        def connect(*a, **kw):
            raise AssertionError("must not connect")
        for source, limit in (("blockchain", 5), ("tg", 0), ("x", 1001)):
            with self.subTest(source=source, limit=limit):
                with self.assertRaises(ValueError):
                    read_collector_texts(source, dsn="fixture", limit=limit, connect=connect)


class StubBackend:
    def predict(self, model, revision, texts):
        return [dict(zip(model.labels, (.1, .2, .7), strict=True)) for _ in texts]


class SourceCliTests(unittest.TestCase):
    @staticmethod
    def revisions():
        return {
            "SENTIMENT_CRYPTOBERT_REVISION": "a" * 40,
            "SENTIMENT_FINTWITBERT_REVISION": "b" * 40,
            "SENTIMENT_RUBERT_REVISION": "c" * 40,
        }

    def test_collector_db_requires_explicit_opt_in(self):
        from intelligence.nlp.cli import run
        with patch.dict(os.environ, self.revisions(), clear=True):
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                result = run(["--collector-db", "x"])
            self.assertEqual(result, 1)
            self.assertFalse(out.getvalue())

    def test_opted_in_collector_scan_outputs_only_prediction_metadata(self):
        from intelligence.nlp.cli import run
        engine = SentimentEngine({key: chr(97+i) * 40
            for i, key in enumerate(("cryptobert","fintwitbert","rubert"))},
            backend=StubBackend())
        source = SourceText("x", "x:tweet:123", "The coin looks very bullish!",
                            TS, TS)
        with patch.dict(os.environ, {**self.revisions(),
                                     "SENTIMENT_SOURCE_READ_ENABLED": "true"}, clear=True):
            with patch("intelligence.nlp.sources.read_collector_texts", return_value=[source]) as reader:
                with patch("intelligence.nlp.cli.SentimentEngine.from_environment", return_value=engine):
                    out, err = io.StringIO(), io.StringIO()
                    with redirect_stdout(out), redirect_stderr(err):
                        result = run(["--collector-db", "x", "--max-items", "10"])
                    self.assertEqual(result, 0, err.getvalue())
                    reader.assert_called_once()
                    self.assertEqual(reader.call_args.kwargs["limit"], 10)
                    row = json.loads(out.getvalue())
                    self.assertEqual(sorted(row["model_results"]),
                                     ["cryptobert","fintwitbert"])
                    self.assertNotIn(source.text, out.getvalue())


if __name__ == "__main__":
    unittest.main()
