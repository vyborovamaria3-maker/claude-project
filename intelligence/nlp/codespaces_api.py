"""Single-request-at-a-time authenticated sentiment API for private Codespaces use.

Not a public production endpoint. Serves loopback only and never reads collector
databases, sends credentials or downloads weights on request.
"""
from __future__ import annotations

import argparse
import hmac
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

from intelligence.nlp.cli import _source_text
from intelligence.nlp.sentiment import LocalTransformersBackend, SentimentEngine

MAX_REQUEST_BYTES = 65536
MAX_ITEMS = 8


def make_handler(secret: str, engine: SentimentEngine) -> type[BaseHTTPRequestHandler]:
    if not isinstance(secret, str) or len(secret) < 32:
        raise ValueError("API bearer token must contain at least 32 characters")

    class Handler(BaseHTTPRequestHandler):
        server_version = "LocalSentiment/1"
        sys_version = ""

        def log_message(self, *_args: Any) -> None:
            # Do not log query strings, source IDs, payloads or Authorization.
            return

        def _respond(self, status: int, content: dict[str, Any]) -> None:
            payload = json.dumps(content, ensure_ascii=False, sort_keys=True).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self) -> None:
            if self.path == "/healthz":
                self._respond(200, {"status": "ready", "network_used": False})
                return
            self._respond(404, {"error": "not_found"})

        def do_POST(self) -> None:
            if self.path != "/v1/sentiment/predict":
                self._respond(404, {"error": "not_found"})
                return
            header = self.headers.get("Authorization", "")
            if not hmac.compare_digest(header, "Bearer " + secret):
                self._respond(401, {"error": "unauthorized"})
                return
            size = self.headers.get("Content-Length", "")
            if len(size) > 5 or not size.isascii() or not size.isdecimal() or not 1 <= int(size) <= MAX_REQUEST_BYTES:
                self._respond(413, {"error": "invalid_request_size"})
                return
            try:
                self.connection.settimeout(30)
                data = json.loads(self.rfile.read(int(size)).decode("utf-8"))
                if not isinstance(data, dict):
                    raise ValueError("request must be object")
                items = data.get("items")
                if not isinstance(items, list) or not 1 <= len(items) <= MAX_ITEMS:
                    raise ValueError("request requires 1..8 items")
                source_items = [_source_text(item) for item in items]
                results = engine.analyze(source_items)
            except (TypeError, ValueError, UnicodeError, json.JSONDecodeError):
                self._respond(400, {"error": "invalid_source_data"})
                return
            except Exception:
                # HF exceptions might embed model cache paths or source text.
                self._respond(503, {"error": "inference_unavailable"})
                return
            self._respond(200, {"results": results})

    return Handler


def run(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Private localhost-only Codespaces BERT sentiment")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args(argv)
    if args.host != "127.0.0.1" or not 1024 <= args.port <= 65535:
        print("Refusing non-loopback or privileged sentiment API listener")
        return 2
    token = os.environ.get("SENTIMENT_API_TOKEN", "")
    if len(token) < 32:
        print("No local API token configured; cannot start")
        return 2
    engine = SentimentEngine.from_environment(
        backend=LocalTransformersBackend(device="cpu", max_loaded_models=1)
    )
    try:
        with HTTPServer(("127.0.0.1", args.port), make_handler(token, engine)) as server:
            print(f"Serving private local inference on 127.0.0.1:{args.port}", flush=True)
            server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        print("Local inference server stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
