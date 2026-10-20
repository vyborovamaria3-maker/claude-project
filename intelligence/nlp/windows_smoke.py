"""No-dependency Windows test of the *remote* Codespaces sentiment client.

Explicitly invoked by windows_remote_smoke.ps1. Never reads X/TG databases,
model weights or private source messages. Runs exactly three synthetic texts.
"""
from __future__ import annotations

import io
import json
import os
import sys
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from pathlib import Path


def run(argv: list[str] | None = None) -> int:
    if os.environ.get("SENTIMENT_REMOTE_ENABLED") != "true":
        print("remote client was not explicitly enabled", file=sys.stderr)
        return 2
    try:
        from intelligence.nlp.cli import run as cli_run
        from intelligence.nlp.remote import RemoteSentimentEngine

        if not isinstance(RemoteSentimentEngine.from_environment().backend, type(None)):
            raise ValueError("remote mode attempted local model backend")

        base = Path.cwd().resolve()
        if not (base / "intelligence" / "nlp" / "remote.py").is_file():
            raise ValueError("script must run from the repository root")

        # Fixed synthetic test records; never access actual collector databases.
        fixed = [
            {"source": "x", "source_id": "x:tweet:10001",
             "text": "Crypto market is bullish on Bitcoin today!",
             "observed_at": "2026-10-19T00:00:00Z"},
            {"source": "tg", "source_id": "tg:message:-100123:10",
             "text": "Это действительно хорошие новости для рынка!",
             "observed_at": "2026-10-19T00:00:00Z"},
            {"source": "tg", "source_id": "tg:message:-100123:11",
             "text": "Bitcoin sentiment is strongly bearish today!",
             "observed_at": "2026-10-19T00:00:00Z"},
        ]
        expected = {
            "x:tweet:10001": {"cryptobert", "fintwitbert"},
            "tg:message:-100123:10": {"rubert"},
            "tg:message:-100123:11": {"cryptobert"},
        }
        db = base / ".local" / "sentiment" / "windows-remote-smoke.sqlite"
        original_stdin = sys.stdin
        sys.stdin = io.StringIO(
            "".join(json.dumps(row, ensure_ascii=True) + "\n" for row in fixed)
        )
        output, errors = io.StringIO(), io.StringIO()
        try:
            with redirect_stdout(output), redirect_stderr(errors):
                status = cli_run([
                    "--batch-size", "2", "--max-items", "3",
                    "--results-db", str(db),
                ])
        finally:
            sys.stdin = original_stdin
        if status != 0:
            raise RuntimeError("remote HTTP classification or SQLite save failed")
        predictions = [json.loads(line) for line in output.getvalue().splitlines()]
        if len(predictions) != 3:
            raise ValueError("wrong prediction count")
        if {row["source_id"]: set(row["model_results"]) for row in predictions} != expected:
            raise ValueError("incorrect original model routing")
        for row in fixed:
            if row["text"] in output.getvalue():
                raise ValueError("raw input appeared in sentiment result")

        print("WINDOWS REMOTE SENTIMENT SMOKE PASSED")
        print("CryptoBERT + FinTwitBERT + RuBERT: same-SHA remote classification OK.")
        print("Results: .local/sentiment/windows-remote-smoke.sqlite")
        print("No local Torch, GPU, collector databases or real X/TG data used.")
        return 0
    except Exception:
        # Never print traceback: it could embed Authorization or source text.
        print("WINDOWS REMOTE SENTIMENT SMOKE FAILED; check private tunnel, Codespace API and model pins.",
              file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(run())
