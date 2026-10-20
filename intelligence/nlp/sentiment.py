"""Local, opt-in sentiment inference for observed X/TG messages.

No model weights are shipped here; a model must be cached *explicitly*
and loaded from an exact 40-digit Hugging Face revision in offline mode.
Class probabilities retain model-specific semantics (stance vs sentiment).
"""
from __future__ import annotations

import hashlib
import math
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Protocol, Sequence

from intelligence.core.models import IntelligenceDocument


@dataclass(frozen=True)
class ModelSpec:
    key: str
    repository: str
    revision_env: str
    labels: tuple[str, str, str]
    task: str
    max_tokens: int


CRYPTO = ModelSpec(
    "cryptobert", "ElKulako/cryptobert", "SENTIMENT_CRYPTOBERT_REVISION",
    ("bearish", "neutral", "bullish"), "crypto_stance", 128,
)
FINTWIT = ModelSpec(
    "fintwitbert", "StephanAkkerman/FinTwitBERT-sentiment",
    "SENTIMENT_FINTWITBERT_REVISION",
    ("neutral", "bullish", "bearish"), "financial_stance", 256,
)
RUBERT = ModelSpec(
    "rubert", "seara/rubert-tiny2-russian-sentiment",
    "SENTIMENT_RUBERT_REVISION",
    ("neutral", "positive", "negative"), "general_sentiment", 256,
)
MODELS = {spec.key: spec for spec in (CRYPTO, FINTWIT, RUBERT)}
SCHEMA_VERSION = "sentiment-v1"
PREPROCESS_VERSION = "minimal-v1"

_URL = re.compile(r"https?://\S+", re.IGNORECASE)
_HANDLE = re.compile(r"(?<!\w)@[a-zA-Z0-9_]{1,30}")
_TICKER = re.compile(r"\$[a-zA-Z][a-zA-Z0-9_]{1,19}")
_REVISION = re.compile(r"^[0-9a-f]{40}$")
_CYRILLIC = re.compile(r"[А-Яа-яЁё]")
_LATIN = re.compile(r"[A-Za-z]")


@dataclass(frozen=True)
class SourceText:
    source: str
    source_id: str
    text: str
    observed_at: datetime
    occurred_at: datetime | None = None


class PredictionBackend(Protocol):
    def predict(self, model: ModelSpec, revision: str, texts: Sequence[str]) -> list[dict[str, float]]:
        """One probability map per input; all labels, not just top-1."""


def _timestamp(value: datetime, field: str) -> str:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(field + " must be timezone-aware")
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _source_key(value: str) -> str:
    return {"twitter": "x", "x": "x", "telegram": "tg", "tg": "tg"}.get(value.strip().lower(), "")


def _validated(item: SourceText) -> tuple[str, str, str, str]:
    source = _source_key(item.source)
    if not source:
        raise ValueError("unsupported sentiment source")
    if not isinstance(item.source_id, str) or not item.source_id or len(item.source_id) > 300:
        raise ValueError("invalid source_id")
    expected = (r"^x:tweet:[1-9][0-9]*$" if source == "x"
                else r"^tg:message:-?[1-9][0-9]*:[1-9][0-9]*$")
    if not re.fullmatch(expected, item.source_id):
        raise ValueError("source_id must contain the canonical original message identity")
    if not isinstance(item.text, str) or len(item.text) > 16000:
        raise ValueError("invalid or oversized message text")
    observed = _timestamp(item.observed_at, "observed_at")
    occurred = _timestamp(item.occurred_at, "occurred_at") if item.occurred_at else observed
    if occurred > observed:
        # Clock-skewed source messages are explicitly not valid historical evidence.
        raise ValueError("occurred_at cannot be after observed_at")
    return source, observed, occurred, hashlib.sha256(item.text.encode("utf-8")).hexdigest()


def _clean(text: str) -> str:
    text = _URL.sub(" URL ", text)
    return _HANDLE.sub(" USER ", text).strip()


def detect_language(text: str) -> str:
    """Conservative heuristic: mixed/unknown messages are not falsely classified."""
    # Ignore tickers/links/handles for language detection; placeholders such
    # as ASSET and URL would otherwise turn a short Russian post into English.
    scrubbed = _TICKER.sub(" ", _HANDLE.sub(" ", _URL.sub(" ", text)))
    cyr = len(_CYRILLIC.findall(scrubbed))
    latin = len(_LATIN.findall(scrubbed))
    total = cyr + latin
    if total < 4:
        return "unknown"
    ratio = cyr / total
    if cyr >= 4 and ratio >= 0.70:
        return "ru"
    if latin >= 4 and ratio <= 0.10:
        return "en"
    return "mixed"


def route_models(source: str, language: str) -> tuple[str, ...]:
    if language == "ru" and source == "tg":
        return ("rubert",)
    if language == "en" and source == "x":
        return ("cryptobert", "fintwitbert")
    if language == "en" and source == "tg":
        return ("cryptobert",)
    return ()


class LocalTransformersBackend:
    """Lazy local-only PyTorch model loader; never contacts HF Hub on inference."""
    def __init__(self, *, device: str = "cpu") -> None:
        if device != "cpu" and not re.fullmatch(r"cuda:[0-9]+", device):
            raise ValueError("device must be cpu or cuda:<index>")
        self.device = device
        self._loaded: dict[tuple[str, str], tuple[Any, Any]] = {}

    def predict(self, model: ModelSpec, revision: str, texts: Sequence[str]) -> list[dict[str, float]]:
        # Heavy deps are intentionally optional for normal collector/CI startup.
        try:
            import torch
            from transformers import AutoModelForSequenceClassification, AutoTokenizer
        except ImportError as exc:
            raise RuntimeError("install intelligence/requirements-sentiment.txt explicitly") from exc
        key = (model.key, revision)
        if key not in self._loaded:
            opts = dict(revision=revision, local_files_only=True, trust_remote_code=False)
            tokenizer = AutoTokenizer.from_pretrained(model.repository, **opts)
            loaded = AutoModelForSequenceClassification.from_pretrained(
                model.repository, use_safetensors=True, **opts
            )
            label_map = tuple(str(loaded.config.id2label[i]).lower() for i in range(3))
            if label_map != model.labels or int(loaded.config.num_labels) != 3:
                raise ValueError("unexpected model label order for " + model.key)
            loaded.to(self.device)
            loaded.eval()
            self._loaded[key] = (tokenizer, loaded)
        tokenizer, loaded = self._loaded[key]
        values = tokenizer(list(texts), truncation=True, padding=True,
                           max_length=model.max_tokens, return_tensors="pt")
        values = {k: v.to(self.device) for k, v in values.items()}
        with torch.inference_mode():
            probabilities = torch.softmax(loaded(**values).logits, dim=-1).cpu().tolist()
        return [dict(zip(model.labels, map(float, row), strict=True)) for row in probabilities]


class SentimentEngine:
    """Batched inference, separate per-model output, no guessed token sentiment."""
    def __init__(
        self, revisions: dict[str, str], *, backend: PredictionBackend | None = None,
        batch_size: int = 8,
    ) -> None:
        if not 1 <= batch_size <= 32:
            raise ValueError("batch_size must be 1..32")
        if set(revisions) != set(MODELS) or any(not _REVISION.fullmatch(v) for v in revisions.values()):
            raise ValueError("all three model revisions must be pinned to 40-hex commit SHAs")
        self.revisions = dict(revisions)
        self.backend = backend if backend is not None else LocalTransformersBackend()
        self.batch_size = batch_size

    @classmethod
    def from_environment(cls, *, backend: PredictionBackend | None = None) -> "SentimentEngine":
        revisions = {key: os.environ.get(model.revision_env, "") for key, model in MODELS.items()}
        return cls(
            revisions, backend=backend if backend is not None else LocalTransformersBackend(
                device=os.environ.get("SENTIMENT_DEVICE", "cpu")
            ),
            batch_size=int(os.environ.get("SENTIMENT_BATCH_SIZE", "8")),
        )

    def analyze(self, items: Sequence[SourceText]) -> list[dict[str, Any]]:
        if len(items) > 1000:
            raise ValueError("one analysis batch cannot exceed 1000 messages")
        inference_at = _timestamp(datetime.now(timezone.utc), "inference_at")
        records: list[dict[str, Any]] = []
        groups: dict[str, list[tuple[int, str]]] = {}
        for item in items:
            source, observed, occurred, content_hash = _validated(item)
            language = detect_language(item.text)
            names = route_models(source, language)
            record: dict[str, Any] = {
                "schema_version": SCHEMA_VERSION, "source": source,
                "source_id": item.source_id, "observed_at": observed,
                "occurred_at": occurred, "content_sha256": content_hash,
                "preprocess_version": PREPROCESS_VERSION, "language": language,
                "inference_at": inference_at,
                "model_results": {},
                "status": "classified" if names else "unsupported_language",
            }
            records.append(record)
            for name in names:
                groups.setdefault(name, []).append((len(records) - 1, _clean(item.text)))
        for key, group in groups.items():
            spec = MODELS[key]
            for offset in range(0, len(group), self.batch_size):
                chunk = group[offset:offset + self.batch_size]
                result = self.backend.predict(spec, self.revisions[key], [text for _, text in chunk])
                if len(result) != len(chunk):
                    raise ValueError("model returned wrong batch size: " + key)
                for (idx, _), probs in zip(chunk, result, strict=True):
                    if set(probs) != set(spec.labels):
                        raise ValueError("model returned unknown classes: " + key)
                    if any(type(value) not in (float, int) or not math.isfinite(value)
                           or not 0 <= value <= 1 for value in probs.values()):
                        raise ValueError("invalid model probabilities: " + key)
                    if abs(sum(probs.values()) - 1.0) > 0.002:
                        raise ValueError("probabilities do not sum to one: " + key)
                    records[idx]["model_results"][key] = {
                        "model": spec.repository, "revision": self.revisions[key],
                        "task": spec.task, "labels": dict(probs),
                        "max_tokens": spec.max_tokens,
                    }
        return records

    def enrich_document(self, document: IntelligenceDocument) -> IntelligenceDocument:
        """Persist alongside existing document metrics; no change to raw evidence."""
        if _source_key(document.source) == "":
            return document
        result = self.analyze([SourceText(
            source=document.source, source_id=document.id, text=document.content,
            observed_at=document.collected_at, occurred_at=document.published_at,
        )])[0]
        document.metrics = {**document.metrics, SCHEMA_VERSION: result}
        return document
