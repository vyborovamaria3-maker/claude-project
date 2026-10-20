"""Offline HTTP loopback integration for Codespaces pinned-model client."""
from __future__ import annotations

import io
import json
import os
import threading
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import patch

from intelligence.nlp import cli
from intelligence.nlp.codespaces_api import make_handler
from intelligence.nlp.remote import RemoteInferenceError, RemoteSentimentEngine
from intelligence.nlp.sentiment import SentimentEngine, SourceText

REV = {"cryptobert": "a" * 40, "fintwitbert": "b" * 40, "rubert": "c" * 40}
REV_ENV = {
    "SENTIMENT_CRYPTOBERT_REVISION": REV["cryptobert"],
    "SENTIMENT_FINTWITBERT_REVISION": REV["fintwitbert"],
    "SENTIMENT_RUBERT_REVISION": REV["rubert"],
}
SECRET = "a-test-bearer-token-32-character-long-secret"
TS = datetime(2026, 10, 19, tzinfo=timezone.utc)
ITEMS = [
    SourceText("x", "x:tweet:10001", "Crypto markets look bullish today!", TS),
    SourceText("tg", "tg:message:-100123:2", "Сегодня хорошие новости для рынка!", TS),
    SourceText("tg", "tg:message:-100123:3", "Bitcoin sentiment looks bearish now!", TS),
]


class Stub:
    def predict(self, model, revision, texts):
        return [dict(zip(model.labels, (0.1, 0.2, 0.7), strict=True)) for _ in texts]


class Silent(BaseHTTPRequestHandler):
    def log_message(self, *args):
        return


class RemoteTests(unittest.TestCase):
    def setUp(self):
        local = SentimentEngine(REV, backend=Stub(), batch_size=2)
        self.server = HTTPServer(("127.0.0.1", 0), make_handler(SECRET, local))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/v1/sentiment/predict"

    def tearDown(self):
        self.server.shutdown()
        self.thread.join(timeout=3)
        self.server.server_close()

    def client(self, **kwargs):
        return RemoteSentimentEngine(REV, endpoint=self.url, token=SECRET, batch_size=3, **kwargs)

    def test_true_http_round_trip_three_original_classifiers(self):
        result = self.client().analyze(ITEMS)
        self.assertEqual(len(result), 3)
        self.assertEqual(set(result[0]["model_results"]), {"cryptobert", "fintwitbert"})
        self.assertEqual(set(result[1]["model_results"]), {"rubert"})
        self.assertEqual(set(result[2]["model_results"]), {"cryptobert"})
        text = json.dumps(result, ensure_ascii=False)
        for item in ITEMS:
            self.assertNotIn(item.text, text)
        self.assertEqual(result[0]["model_results"]["cryptobert"]["revision"], REV["cryptobert"])

    def test_injected_raw_text_extra_field_and_forged_hash_are_rejected(self):
        from email.message import Message

        class FakeResponse:
            status = 200
            def __init__(self, payload):
                self.payload = json.dumps(payload).encode("utf-8")
                self.headers = Message()
                self.headers.add_header("Content-Type", "application/json")
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False
            def read(self, max_bytes):
                return self.payload[:max_bytes]

        class FakeOpener:
            def __init__(self, payload):
                self.payload = payload
            def open(self, *_a, **_kw):
                return FakeResponse(self.payload)

        original = SentimentEngine(REV, backend=Stub()).analyze(ITEMS[:1])
        import copy
        altered = copy.deepcopy(original)
        altered[0]["raw_text"] = "secret source value"
        altered_hash = copy.deepcopy(original)
        altered_hash[0]["content_sha256"] = "0" * 64
        altered_weights = copy.deepcopy(original)
        altered_weights[0]["model_results"]["cryptobert"]["labels"]["bullish"] = 1.3
        for payload in (altered, altered_hash, altered_weights):
            with self.subTest(payload=payload[0].keys()):
                client = RemoteSentimentEngine(
                    REV, endpoint=self.url, token=SECRET,
                    opener=FakeOpener({"results": payload}),
                )
                with self.assertRaisesRegex(RemoteInferenceError, "integrity"):
                    client.analyze(ITEMS[:1])

    def test_wrong_pin_refused_even_if_service_is_authenticated(self):
        pins = dict(REV)
        pins["cryptobert"] = "d" * 40
        client = RemoteSentimentEngine(pins, endpoint=self.url, token=SECRET)
        with self.assertRaisesRegex(RemoteInferenceError, "integrity"):
            client.analyze(ITEMS[:1])

    def test_invalid_token_redacts_request_and_does_not_return_source_text(self):
        client = RemoteSentimentEngine(REV, endpoint=self.url, token="x" * 40)
        with self.assertRaises(RemoteInferenceError) as cm:
            client.analyze(ITEMS[:1])
        self.assertNotIn(SECRET, str(cm.exception))
        self.assertNotIn(ITEMS[0].text, str(cm.exception))

    def test_unsafe_remote_urls_and_missing_token_fail_closed(self):
        urls = [
            "http://example.com/v1/sentiment/predict",
            "http://192.168.1.2/v1/sentiment/predict",
            "https://user:secret@example.com/v1/sentiment/predict",
            "https://example.com/v1/sentiment/predict?token=leak",
            "file:///v1/sentiment/predict",
            "https://example.com/other",
        ]
        for url in urls:
            with self.subTest(url=url):
                with self.assertRaises(ValueError):
                    RemoteSentimentEngine(REV, endpoint=url, token=SECRET)
        with self.assertRaises(ValueError):
            RemoteSentimentEngine(REV, endpoint=self.url, token="")

    def test_missing_opt_in_never_makes_http_request(self):
        with patch.dict(os.environ, {**REV_ENV,
                                     "SENTIMENT_REMOTE_ENDPOINT": self.url,
                                     "SENTIMENT_REMOTE_TOKEN": SECRET},
                        clear=True):
            with self.assertRaisesRegex(ValueError, "explicit"):
                RemoteSentimentEngine.from_environment()
            engine = SentimentEngine.from_environment()
            self.assertNotIsInstance(engine, RemoteSentimentEngine)

    def test_invalid_source_rejected_before_network(self):
        item = SourceText("tg", "tg:message:invalid",
                          "this is a secret string", TS)
        with self.assertRaisesRegex(ValueError, "canonical"):
            self.client().analyze([item])

    def test_no_redirect_follows_external_or_loopback_location(self):
        hits = []
        class Sink(Silent):
            def do_POST(self):
                hits.append(self.headers.get("Authorization"))
                self.send_response(200)
                self.end_headers()
        target = HTTPServer(("127.0.0.1", 0), Sink)
        t = threading.Thread(target=target.serve_forever, daemon=True)
        t.start()
        class Redirect(Silent):
            def do_POST(self):
                self.send_response(307)
                self.send_header("Location",
                                 f"http://127.0.0.1:{target.server_port}/v1/sentiment/predict")
                self.end_headers()
        jump = HTTPServer(("127.0.0.1", 0), Redirect)
        jt = threading.Thread(target=jump.serve_forever, daemon=True)
        jt.start()
        try:
            client = RemoteSentimentEngine(
                REV, endpoint=f"http://127.0.0.1:{jump.server_port}/v1/sentiment/predict",
                token=SECRET,
            )
            with self.assertRaises(RemoteInferenceError):
                client.analyze(ITEMS[:1])
            self.assertEqual(hits, [])
        finally:
            jump.shutdown()
            jt.join(timeout=2)
            jump.server_close()
            target.shutdown()
            t.join(timeout=2)
            target.server_close()

    def test_cli_remote_opt_in_uses_exact_same_models_without_torch_client(self):
        row = ITEMS[0]
        incoming = json.dumps({
            "source": row.source, "source_id": row.source_id, "text": row.text,
            "observed_at": row.observed_at.isoformat()
        }) + "\n"
        env = {
            **REV_ENV,
            "SENTIMENT_REMOTE_ENABLED": "true",
            "SENTIMENT_REMOTE_ENDPOINT": self.url,
            "SENTIMENT_REMOTE_TOKEN": SECRET,
        }
        with patch.dict(os.environ, env, clear=True):
            with patch.object(cli.sys, "stdin", io.StringIO(incoming)):
                out, err = io.StringIO(), io.StringIO()
                with redirect_stdout(out), redirect_stderr(err):
                    code = cli.run(["--batch-size", "1", "--max-items", "1"])
        self.assertEqual(code, 0, err.getvalue())
        prediction = json.loads(out.getvalue())
        self.assertEqual(set(prediction["model_results"]), {"cryptobert", "fintwitbert"})
        self.assertNotIn(row.text, out.getvalue())

    def test_remote_skipped_by_default_in_worker_setup(self):
        from intelligence.bootstrap import build_memory_runtime
        env = {**REV_ENV, "SENTIMENT_REMOTE_ENABLED": "true",
               "SENTIMENT_REMOTE_ENDPOINT": self.url,
               "SENTIMENT_REMOTE_TOKEN": SECRET}
        with patch.dict(os.environ, env, clear=True):
            runtime = build_memory_runtime()
            try:
                self.assertIsNone(runtime.worker.sentiment)
            finally:
                runtime.close()


if __name__ == "__main__":
    unittest.main()
