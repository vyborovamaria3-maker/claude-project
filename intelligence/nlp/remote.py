"""Opt-in remote access to the *same three pinned* sentiment models.

This is an HTTP adapter to our private inference service, not an LLM and not
a model substitution. Source text leaves the client only on explicit opt-in.
No Torch, Transformers, HTTP retry, collector DB access or model downloads.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any, Sequence

from intelligence.core.models import IntelligenceDocument
from intelligence.nlp.sentiment import (
    MODELS, PREPROCESS_VERSION, SCHEMA_VERSION, SourceText,
    _source_key, _timestamp, _validated, detect_language, route_models,
)


class RemoteInferenceError(RuntimeError):
    """Remote model inference was unavailable or failed validation."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


def _endpoint(value: str) -> str:
    if not isinstance(value, str) or len(value) > 2048:
        raise ValueError("invalid remote sentiment endpoint")
    try:
        u = urllib.parse.urlsplit(value)
        host = u.hostname
        port = u.port
    except ValueError as exc:
        raise ValueError("invalid remote sentiment endpoint") from exc
    if (not host or u.username or u.password or u.query or u.fragment
            or u.path != "/v1/sentiment/predict"):
        raise ValueError("remote sentiment endpoint must be a direct prediction URL")
    if u.scheme == "http" and host not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("non-loopback remote sentiment requires HTTPS")
    if u.scheme not in {"http", "https"}:
        raise ValueError("remote sentiment requires HTTPS or local loopback HTTP")
    if port is not None and not 1 <= port <= 65535:
        raise ValueError("invalid sentiment port")
    return value


def _sha(value: str) -> bool:
    return isinstance(value, str) and bool(re.fullmatch(r"[0-9a-f]{40}", value))


class RemoteSentimentEngine:
    """Minimal authenticated client with full result/provenance verification."""

    def __init__(
        self, revisions: dict[str, str], *, endpoint: str, token: str,
        batch_size: int = 2, timeout_seconds: float = 90.0,
        opener: Any = None,
    ) -> None:
        if set(revisions) != set(MODELS) or any(not _sha(v) for v in revisions.values()):
            raise ValueError("all three immutable model revisions must be pinned")
        if not isinstance(token, str) or not 32 <= len(token) <= 512 or any(
            ord(c) < 33 or ord(c) > 126 for c in token
        ):
            raise ValueError("remote sentiment API bearer token is missing or invalid")
        if type(batch_size) is not int or not 1 <= batch_size <= 8:
            raise ValueError("remote sentiment batch size must be 1..8")
        if not math.isfinite(timeout_seconds) or not 1 <= timeout_seconds <= 300:
            raise ValueError("invalid remote sentiment timeout")
        self.revisions = dict(revisions)
        self.endpoint = _endpoint(endpoint)
        self.token = token
        self.batch_size = batch_size
        self.timeout_seconds = timeout_seconds
        # No process-memory priority/probes are needed on the thin client.
        self.backend = None
        # Prevent redirects from forwarding Authorization to another host.
        # Do not send raw source texts via unintended environment HTTP proxies.
        self._opener = opener if opener is not None else urllib.request.build_opener(
            urllib.request.ProxyHandler({}), _NoRedirect()
        )

    @classmethod
    def from_environment(cls) -> "RemoteSentimentEngine":
        import os
        if os.environ.get("SENTIMENT_REMOTE_ENABLED") != "true":
            raise ValueError("remote inference requires explicit SENTIMENT_REMOTE_ENABLED=true")
        return cls(
            {k: os.environ.get(m.revision_env, "") for k, m in MODELS.items()},
            endpoint=os.environ.get("SENTIMENT_REMOTE_ENDPOINT", ""),
            token=os.environ.get("SENTIMENT_REMOTE_TOKEN", ""),
            batch_size=int(os.environ.get("SENTIMENT_BATCH_SIZE", "2")),
            timeout_seconds=float(os.environ.get("SENTIMENT_REMOTE_TIMEOUT_SECONDS", "90")),
        )

    def analyze(self, items: Sequence[SourceText]) -> list[dict[str, Any]]:
        if len(items) > min(self.batch_size, 8):
            raise ValueError("remote inference input exceeds configured batch size")
        if not items:
            return []
        originals: list[tuple[str, str, str, str, str, tuple[str, ...]]] = []
        payload: list[dict[str, str]] = []
        for item in items:
            source, observed, occurred, content_hash = _validated(item)
            language = detect_language(item.text)
            originals.append((
                source, observed, occurred, content_hash, language,
                route_models(source, language),
            ))
            payload.append({
                "source": source, "source_id": item.source_id, "text": item.text,
                "observed_at": observed, "occurred_at": occurred,
            })
        body = json.dumps({"items": payload}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(body) > 65536:
            raise ValueError("remote sentiment JSON batch exceeds 64 KiB")
        req = urllib.request.Request(
            self.endpoint, data=body, method="POST", headers={
                "Authorization": "Bearer " + self.token,
                "Content-Type": "application/json",
                "Accept": "application/json",
            }
        )
        try:
            with self._opener.open(req, timeout=self.timeout_seconds) as response:
                if response.status != 200:
                    raise RemoteInferenceError("remote sentiment request failed")
                if response.headers.get_content_type() != "application/json":
                    raise RemoteInferenceError("remote sentiment response is not JSON")
                data = response.read(262145)
                if len(data) > 262144:
                    raise RemoteInferenceError("remote sentiment response exceeds 256 KiB")
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise RemoteInferenceError("remote sentiment service unavailable") from None
        try:
            decoded = json.loads(data)
            rows = decoded["results"]
            if not isinstance(rows, list) or len(rows) != len(items):
                raise ValueError("result length mismatch")
            for item, original, row in zip(items, originals, rows, strict=True):
                source, observed, occurred, digest, language, names = original
                if not isinstance(row, dict):
                    raise ValueError("malformed result")
                expected = {
                    "source": source, "source_id": item.source_id, "observed_at": observed,
                    "occurred_at": occurred, "content_sha256": digest,
                    "language": language, "schema_version": SCHEMA_VERSION,
                    "preprocess_version": PREPROCESS_VERSION,
                    "status": "classified" if names else "unsupported_language",
                }
                if any(row.get(key) != value for key, value in expected.items()):
                    raise ValueError("source provenance does not match input")
                when = row.get("inference_at")
                if not isinstance(when, str):
                    raise ValueError("missing inference time")
                parsed = datetime.fromisoformat(when.replace("Z", "+00:00"))
                if parsed.utcoffset() is None:
                    raise ValueError("inference time lacks timezone")
                if not isinstance(row.get("model_results"), dict):
                    raise ValueError("missing model map")
                if set(row["model_results"]) != set(names):
                    raise ValueError("model routing mismatch")
                for name, result in row["model_results"].items():
                    spec = MODELS[name]
                    if not isinstance(result, dict) or any((
                        result.get("model") != spec.repository,
                        result.get("revision") != self.revisions[name],
                        result.get("task") != spec.task,
                        result.get("max_tokens") != spec.max_tokens,
                    )):
                        raise ValueError("unexpected model identity or SHA")
                    scores = result.get("labels")
                    if not isinstance(scores, dict) or set(scores) != set(spec.labels):
                        raise ValueError("unexpected sentiment classes")
                    if any(type(s) not in (int, float) or not math.isfinite(s)
                           or not 0 <= s <= 1 for s in scores.values()):
                        raise ValueError("invalid remote probabilities")
                    if abs(sum(scores.values()) - 1) > 0.002:
                        raise ValueError("remote probabilities not normalized")
            return rows
        except (ValueError, TypeError, KeyError, OverflowError):
            # Never expose untrusted API body, model cache paths or source texts.
            raise RemoteInferenceError("remote sentiment response failed integrity checks") from None

    def enrich_document(self, document: IntelligenceDocument) -> IntelligenceDocument:
        if _source_key(document.source) == "":
            return document
        prediction = self.analyze([SourceText(
            source=document.source, source_id=document.id, text=document.content,
            observed_at=document.collected_at, occurred_at=document.published_at,
        )])[0]
        document.metrics = {**document.metrics, SCHEMA_VERSION: prediction}
        return document
