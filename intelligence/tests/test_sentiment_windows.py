from __future__ import annotations

import io
import json
import os
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timezone
from http.server import HTTPServer
from pathlib import Path
from unittest.mock import patch

from intelligence.nlp import windows_smoke
from intelligence.nlp.codespaces_api import make_handler
from intelligence.nlp.sentiment import SentimentEngine


PINS = {"cryptobert": "a" * 40, "fintwitbert": "b" * 40, "rubert": "c" * 40}
TOKEN = "test-secret-only-not-a-real-codespaces-token-length-safe"


class Stub:
    def predict(self, model, revision, texts):
        return [dict(zip(model.labels, (0.1, 0.2, 0.7), strict=True)) for _ in texts]


class WindowsSmokeTests(unittest.TestCase):
    def test_windows_remote_three_model_smoke_against_fake_local_http(self):
        server = HTTPServer(
            ("127.0.0.1", 0),
            make_handler(TOKEN, SentimentEngine(PINS, backend=Stub(), batch_size=2)),
        )
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                marker = root / "intelligence/nlp/remote.py"
                marker.parent.mkdir(parents=True)
                marker.touch()
                env = {
                    "SENTIMENT_REMOTE_ENABLED": "true",
                    "SENTIMENT_REMOTE_ENDPOINT":
                        f"http://127.0.0.1:{server.server_port}/v1/sentiment/predict",
                    "SENTIMENT_REMOTE_TOKEN": TOKEN,
                    "SENTIMENT_CRYPTOBERT_REVISION": PINS["cryptobert"],
                    "SENTIMENT_FINTWITBERT_REVISION": PINS["fintwitbert"],
                    "SENTIMENT_RUBERT_REVISION": PINS["rubert"],
                    "SENTIMENT_BATCH_SIZE": "2",
                    "SENTIMENT_DEVICE": "cpu",
                }
                with patch.dict(os.environ, env, clear=True):
                    with patch("intelligence.nlp.windows_smoke.Path.cwd", return_value=root):
                        output = io.StringIO()
                        with redirect_stdout(output):
                            result = windows_smoke.run()
                self.assertEqual(result, 0, output.getvalue())
                self.assertIn("WINDOWS REMOTE SENTIMENT SMOKE PASSED", output.getvalue())
                self.assertNotIn("это действительно", output.getvalue().lower())
                db = root / ".local/sentiment/windows-remote-smoke.sqlite"
                self.assertTrue(db.exists())
                import sqlite3
                with sqlite3.connect(db) as conn:
                    rows = conn.execute(
                        "SELECT model_key,COUNT(*) FROM sentiment_predictions GROUP BY model_key"
                    ).fetchall()
                self.assertEqual(dict(rows), {
                    "cryptobert": 2, "fintwitbert": 1, "rubert": 1
                })
        finally:
            server.shutdown()
            thread.join(timeout=3)
            server.server_close()

    def test_windows_script_requires_private_loopback_and_keeps_token_secret(self):
        file = Path(__file__).resolve().parents[2] / "intelligence/nlp/scripts/windows_remote_smoke.ps1"
        source = file.read_text(encoding="utf-8")
        self.assertIn('Invoke-RestMethod -Uri "http://127.0.0.1:8765/healthz"', source)
        self.assertIn('gh codespace ssh -c $CodespaceName', source)
        self.assertIn('python.exe', source)
        self.assertIn('SENTIMENT_REMOTE_ENABLED', source)
        self.assertIn('"intelligence.nlp.windows_smoke"', source.replace("-m intelligence.nlp.windows_smoke", '"intelligence.nlp.windows_smoke"') )
        self.assertNotIn("pip install", source)
        self.assertNotIn("Write-Host $token", source)
        self.assertNotIn("New-NetFirewallRule", source)


if __name__ == "__main__":
    unittest.main()
