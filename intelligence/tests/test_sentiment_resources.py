from __future__ import annotations

import io
import json
import sqlite3
import tempfile
import threading
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from intelligence.nlp import cli
from intelligence.nlp.resources import (
    MemorySample, ResourceController, ResourcePolicy, ResourcePressure,
)
from intelligence.nlp.sentiment import SentimentEngine, SourceText


NOW = datetime(2026, 10, 20, 8, 0, tzinfo=timezone.utc)
REVISIONS = {"cryptobert": "a" * 40, "fintwitbert": "b" * 40,
             "rubert": "c" * 40}


class LaptopResourceTests(unittest.TestCase):
    def test_high_memory_priority_set_once_for_multiple_batches(self):
        calls = []
        ctrl = ResourceController(
            policy=ResourcePolicy(min_free_mb=3072, max_ai_rss_mb=3072,
                                  model_reserve_mb=640),
            sample=lambda: MemorySample(available_mb=5000, ai_rss_mb=1200),
            set_priority=lambda: calls.append("idle"),
        )
        self.assertTrue(ctrl.wait_for_capacity())
        self.assertTrue(ctrl.wait_for_capacity())
        self.assertEqual(calls, ["idle"])

    def test_low_memory_unloads_model_then_proceeds_without_sleep(self):
        calls = []
        readings = iter([
            MemorySample(available_mb=2400, ai_rss_mb=1500),
            MemorySample(available_mb=4600, ai_rss_mb=900),
        ])
        ctrl = ResourceController(
            sample=lambda: next(readings),
            set_priority=lambda: calls.append("idle"),
            sleep=lambda duration: self.fail("unload should recover available RAM"),
        )
        self.assertTrue(ctrl.wait_for_capacity(unload=lambda: calls.append("unload")))
        self.assertEqual(calls, ["idle", "unload"])

    def test_low_memory_defers_and_times_out_without_running_inference(self):
        clock = [0.0]
        delays = []
        def wait(seconds):
            delays.append(seconds)
            clock[0] += seconds
        ctrl = ResourceController(
            policy=ResourcePolicy(poll_seconds=2.0, max_wait_seconds=5.0),
            sample=lambda: MemorySample(available_mb=1100, ai_rss_mb=2000),
            monotonic=lambda: clock[0], sleep=wait,
            set_priority=lambda: None,
        )
        calls = []
        with self.assertRaisesRegex(ResourcePressure, "insufficient laptop RAM"):
            ctrl.wait_for_capacity(unload=lambda: calls.append("unload"))
        self.assertEqual(calls, ["unload"])
        self.assertEqual(delays, [2.0, 2.0, 1.0])

    def test_stop_interrupts_resource_pause(self):
        stop = threading.Event()
        ctrl = ResourceController(
            stop=stop,
            sample=lambda: MemorySample(available_mb=1500, ai_rss_mb=1800),
            set_priority=lambda: None,
            sleep=lambda _: stop.set(),
        )
        self.assertFalse(ctrl.wait_for_capacity())
        self.assertTrue(stop.is_set())

    def test_metrics_unavailable_or_invalid_fail_closed(self):
        for bad in (MemorySample(float("nan"), 1100),
                    MemorySample(8000, float("inf")),
                    MemorySample(-10, 700)):
            with self.subTest(bad=bad):
                guard = ResourceController(sample=lambda: bad, set_priority=lambda: None)
                with self.assertRaises(ResourcePressure):
                    guard.wait_for_capacity()
        with self.assertRaises(ValueError):
            ResourcePolicy(min_free_mb=0)
        with self.assertRaises(ValueError):
            ResourcePolicy(max_wait_seconds=float("nan"))

    def test_priority_change_fails_closed(self):
        def failed():
            raise ResourcePressure("could not lower local AI process priority")
        guard = ResourceController(
            sample=lambda: MemorySample(12000, 600), set_priority=failed
        )
        with self.assertRaises(ResourcePressure):
            guard.wait_for_capacity()


class StopAfterFirstBatch:
    def __init__(self, stop: threading.Event, fail_second=False):
        self.stop = stop
        self.calls = 0
        self.fail_second = fail_second

    def predict(self, model, revision, texts):
        self.calls += 1
        if self.fail_second and self.calls >= 2:
            raise RuntimeError("fixture model crashed on second batch")
        if self.calls == 1:
            self.stop.set()
        return [dict(zip(model.labels, (0.1, 0.2, 0.7), strict=True))
                for _ in texts]


class DurableStopTests(unittest.TestCase):
    def rows(self):
        return [
            SourceText("tg", "tg:message:-100123:1", "Рынок уверенно растет!", NOW),
            SourceText("tg", "tg:message:-100123:2", "Это прекрасная новость!", NOW),
            SourceText("tg", "tg:message:-100123:3", "Сейчас отличные новости!", NOW),
        ]

    def test_sigint_style_stop_saves_completed_first_batch_only_then_resumes(self):
        from intelligence.nlp.results_store import store_predictions
        with tempfile.TemporaryDirectory() as folder:
            db = str(Path(folder) / "sentiment.sqlite")
            stop = threading.Event()
            model = StopAfterFirstBatch(stop)
            engine = SentimentEngine(REVISIONS, backend=model, batch_size=1)
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                code = cli._process_in_chunks(
                    engine, self.rows(), batch_size=1, results_db=db, stop=stop
                )
            self.assertEqual(code, 130)
            self.assertEqual(model.calls, 1, "do not start second batch after stop")
            self.assertEqual(len(stdout.getvalue().splitlines()), 1)
            with sqlite3.connect(db) as conn:
                self.assertEqual(conn.execute(
                    "SELECT count(*) FROM sentiment_predictions").fetchone()[0], 1)
            # A later explicit bounded rerun resumes idempotently.
            stop.clear()
            rerun = SentimentEngine(REVISIONS, backend=AlwaysGood(), batch_size=1)
            with redirect_stdout(io.StringIO()):
                self.assertEqual(cli._process_in_chunks(
                    rerun, self.rows(), batch_size=1, results_db=db, stop=stop
                ), 0)
            with sqlite3.connect(db) as conn:
                self.assertEqual(conn.execute(
                    "SELECT count(*) FROM sentiment_predictions").fetchone()[0], 3)

    def test_middle_batch_exception_never_discards_prior_commits(self):
        from intelligence.nlp.results_store import store_predictions
        with tempfile.TemporaryDirectory() as folder:
            db = str(Path(folder) / "sentiment.sqlite")
            stop = threading.Event()
            mock = StopAfterFirstBatch(stop, fail_second=True)
            # Deliberately allow a second call so we can test mid-run failure.
            mock.stop = threading.Event()
            def predict(model, revision, texts):
                mock.calls += 1
                if mock.calls == 2:
                    raise RuntimeError("synthetic provider failure")
                return [dict(zip(model.labels, (0.1, 0.2, 0.7), strict=True))
                        for _ in texts]
            mock.predict = predict
            engine = SentimentEngine(REVISIONS, backend=mock, batch_size=1)
            with redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(RuntimeError, "synthetic"):
                    cli._process_in_chunks(
                        engine, self.rows(), batch_size=1, results_db=db, stop=stop
                    )
            with sqlite3.connect(db) as conn:
                self.assertEqual(conn.execute(
                    "SELECT count(*) FROM sentiment_predictions").fetchone()[0], 1)


class AlwaysGood:
    def predict(self, model, revision, texts):
        return [dict(zip(model.labels, (0.1, 0.2, 0.7), strict=True))
                for _ in texts]


if __name__ == "__main__":
    unittest.main()
