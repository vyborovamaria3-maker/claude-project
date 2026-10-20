from __future__ import annotations

import io
import json
import os
import unittest
from contextlib import redirect_stdout, redirect_stderr
from unittest.mock import patch

from intelligence.nlp.cli import run
from intelligence.nlp.sentiment import SentimentEngine


REV_ENV = {
    "SENTIMENT_CRYPTOBERT_REVISION": "a" * 40,
    "SENTIMENT_FINTWITBERT_REVISION": "b" * 40,
    "SENTIMENT_RUBERT_REVISION": "c" * 40,
}

class StubBackend:
    def predict(self, model, revision, texts):
        return [{label: prob for label, prob in zip(model.labels, (.2, .3, .5))}
                for _ in texts]

class SentimentCliTests(unittest.TestCase):
    def test_check_config_does_not_download_weights_or_open_source(self):
        with patch.dict(os.environ, REV_ENV):
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                code = run(["--check-config"])
            self.assertEqual(code, 0, err.getvalue())
            value = json.loads(out.getvalue())
            self.assertFalse(value["network_used"])
            self.assertEqual(value["models"]["cryptobert"], "a" * 40)

    def test_bounded_jsonl_output_contains_no_original_message_text(self):
        from intelligence.nlp import cli
        orig_in = cli.sys.stdin
        row = {"source": "tg", "source_id": "tg:message:-100111:8",
               "text": "Сегодня очень хорошие новости для рынка!",
               "observed_at": "2026-10-20T08:00:00Z"}
        text_input = json.dumps(row, ensure_ascii=False) + "\n"
        cli.sys.stdin = io.StringIO(text_input)
        engine = SentimentEngine({"cryptobert": "a"*40,
                                  "fintwitbert": "b"*40, "rubert": "c"*40},
                                 backend=StubBackend())
        try:
            with patch.object(cli.SentimentEngine, "from_environment", return_value=engine):
                out, err = io.StringIO(), io.StringIO()
                with redirect_stdout(out), redirect_stderr(err):
                    self.assertEqual(run(["--max-items", "2"]), 0)
                self.assertNotIn(row["text"], out.getvalue())
                result = json.loads(out.getvalue())
                self.assertEqual(result["model_results"]["rubert"]["labels"]["negative"], .5)
                self.assertEqual(result["source_id"], row["source_id"])
        finally:
            cli.sys.stdin = orig_in

    def test_invalid_source_rejected_without_input_echo(self):
        from intelligence.nlp import cli
        orig_in = cli.sys.stdin
        cli.sys.stdin = io.StringIO(json.dumps({
            "source": "tg", "source_id": "tg:message:bad",
            "text": "api_key=secret value",
            "observed_at": "2026-10-20T08:00:00Z",
        }) + "\n")
        try:
            with patch.dict(os.environ, REV_ENV):
                out, err = io.StringIO(), io.StringIO()
                with redirect_stdout(out), redirect_stderr(err):
                    self.assertEqual(run(["--max-items", "2"]), 1)
                self.assertNotIn("secret", err.getvalue())
                self.assertNotIn("secret", out.getvalue())
                self.assertFalse(out.getvalue().strip())
        finally:
            cli.sys.stdin = orig_in

if __name__ == "__main__":
    unittest.main()
