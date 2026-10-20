from __future__ import annotations

import http.client
import json
import subprocess
import threading
import unittest
from datetime import datetime, timezone
from http.server import HTTPServer
from pathlib import Path

from intelligence.nlp import codespaces_api
from intelligence.nlp.sentiment import SentimentEngine


SECRET = "codespaces-test-bearer-token-long-enough-for-test"
SHA = {"cryptobert": "a" * 40, "fintwitbert": "b" * 40, "rubert": "c" * 40}


class Stub:
    def predict(self, model, revision, texts):
        return [dict(zip(model.labels, (0.1, 0.2, 0.7), strict=True)) for _ in texts]


class CodespacesApiTests(unittest.TestCase):
    def setUp(self):
        engine = SentimentEngine(SHA, backend=Stub(), batch_size=2)
        self.server = HTTPServer(("127.0.0.1", 0), codespaces_api.make_handler(SECRET, engine))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.thread.join(timeout=2)
        self.server.server_close()

    def request(self, path, *, content=None, token=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        try:
            h = dict(headers or {})
            if token is not None:
                h["Authorization"] = "Bearer " + token
            if content is not None and "Content-Length" not in h:
                h["Content-Length"] = str(len(content))
            c.request("POST", path, body=content if content is not None else b"", headers=h)
            res = c.getresponse()
            return res.status, json.loads(res.read())
        finally:
            c.close()

    def test_authenticated_request_routes_three_exact_models_no_text_leak(self):
        items = [
            {"source": "x", "source_id": "x:tweet:101",
             "text": "Crypto market is bullish today!",
             "observed_at": "2026-10-19T00:00:00Z"},
            {"source": "tg", "source_id": "tg:message:-100123:2",
             "text": "Сегодня прекрасные новости для рынка!",
             "observed_at": "2026-10-19T00:00:00Z"},
        ]
        raw = json.dumps({"items": items}, ensure_ascii=False).encode("utf-8")
        status, result = self.request("/v1/sentiment/predict", content=raw, token=SECRET)
        self.assertEqual(status, 200)
        self.assertEqual(len(result["results"]), 2)
        self.assertEqual(set(result["results"][0]["model_results"]),
                         {"cryptobert", "fintwitbert"})
        self.assertEqual(set(result["results"][1]["model_results"]), {"rubert"})
        self.assertNotIn(items[0]["text"], json.dumps(result, ensure_ascii=False))
        self.assertNotIn(items[1]["text"], json.dumps(result, ensure_ascii=False))

    def test_unknown_or_missing_token_never_runs_inference(self):
        sample = json.dumps({"items": []}).encode()
        for token in (None, "incorrect-guess"):
            with self.subTest(token=token):
                status, payload = self.request("/v1/sentiment/predict", content=sample, token=token)
                self.assertEqual(status, 401)
                self.assertEqual(payload, {"error": "unauthorized"})

    def test_bad_source_and_large_or_missing_request_are_rejected(self):
        text = "my secret message"
        item = {"source": "x", "source_id": "x:tweet:invalid",
                "text": text, "observed_at": "2026-10-19T00:00:00Z"}
        raw = json.dumps({"items":[item]}).encode()
        status, data = self.request("/v1/sentiment/predict", content=raw, token=SECRET)
        self.assertEqual(status, 400)
        self.assertNotIn(text, json.dumps(data))
        status, _ = self.request("/v1/sentiment/predict", content=b"{}",
                                 token=SECRET, headers={"Content-Length": "9999999999"})
        self.assertEqual(status, 413)

    def test_listener_refuses_public_bind(self):
        self.assertEqual(codespaces_api.run(["--host", "0.0.0.0"]), 2)

    def test_setup_and_api_scripts_are_bash_parseable_and_cpu_only(self):
        root = Path(__file__).resolve().parents[2]
        setup = root / "intelligence/nlp/scripts/codespaces_setup.sh"
        api = root / "intelligence/nlp/scripts/codespaces_api.sh"
        for path in (setup, api):
            with self.subTest(path=path):
                r = subprocess.run(["bash", "-n", str(path)], capture_output=True, text=True)
                self.assertEqual(r.returncode, 0, r.stderr)
        code = setup.read_text()
        self.assertIn("https://download.pytorch.org/whl/cpu", code)
        self.assertIn("HF_HUB_OFFLINE=1", code)
        self.assertIn("smoke-predictions.jsonl", code)
        self.assertIn("CODESPACES", code)
        self.assertIn('if ! "$P" -m pip --version', code)
        self.assertIn('"$PYTHON" -m venv --clear "$VENV"', code)
        self.assertNotIn("cuda:0", code.lower())


if __name__ == "__main__":
    unittest.main()
