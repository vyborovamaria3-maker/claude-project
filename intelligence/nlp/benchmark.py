"""Offline human-labelled sentiment benchmark; never treats fixtures as live accuracy.

Prediction payloads contain hashes and labels, not original text. Gold records
must be manually annotated to match a SPECIFIC source message content hash.
Bullish/Bearish stance and Russian Positive/Negative remain separate tasks.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

from intelligence.nlp.sentiment import MODELS


MAX_RECORDS = 20_000
MAX_LINE = 50_000


def _load(path: str | Path) -> list[dict[str, Any]]:
    records = []
    with Path(path).open("r", encoding="utf-8") as handle:
        for line in handle:
            if len(line) > MAX_LINE or len(records) >= MAX_RECORDS:
                raise ValueError("benchmark input exceeds bounded limits")
            if line.strip():
                record = json.loads(line)
                if not isinstance(record, dict):
                    raise ValueError("benchmark input record must be an object")
                records.append(record)
    return records


def _identity(row: dict[str, Any]) -> tuple[str, str, str]:
    source, source_id, digest = (row.get(field) for field in
                                  ("source", "source_id", "content_sha256"))
    if (source not in ("x", "tg") or not isinstance(source_id, str)
            or not source_id or not isinstance(digest, str)
            or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest)):
        raise ValueError("invalid evidence identity in benchmark")
    return source, source_id, digest


def evaluate(
    predictions: list[dict[str, Any]], labelled: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    gold = {}
    for item in labelled:
        key = _identity(item)
        if key in gold:
            raise ValueError("duplicate gold evidence identity")
        truths = item.get("labels")
        if not isinstance(truths, dict) or not truths:
            raise ValueError("gold labels must be a per-model dictionary")
        for model, label in truths.items():
            if model not in MODELS or label not in MODELS[model].labels:
                raise ValueError("unknown gold model or label")
        gold[key] = truths
    predictions_by_identity = {}
    for item in predictions:
        key = _identity(item)
        if key in predictions_by_identity:
            raise ValueError("duplicate prediction evidence identity")
        predictions_by_identity[key] = item
    # Split groups by source, model and revision. Never pool scores across
    # incompatible labels or model weights.
    matrix: dict[tuple[str, str, str], dict[tuple[str, str], int]] = defaultdict(
        lambda: defaultdict(int)
    )
    expected: dict[tuple[str, str], int] = defaultdict(int)
    for identity, truths in gold.items():
        for name, truth in truths.items():
            expected[(identity[0], name)] += 1
            p = predictions_by_identity.get(identity)
            if p is None:
                continue
            result = p.get("model_results", {}).get(name)
            if not isinstance(result, dict):
                continue
            spec = MODELS[name]
            if result.get("model") != spec.repository or result.get("task") != spec.task:
                raise ValueError("model definition differs from source contract")
            revision = result.get("revision")
            if not isinstance(revision, str) or len(revision) != 40 or any(
                c not in "0123456789abcdef" for c in revision
            ):
                raise ValueError("unverified model revision")
            scores = result.get("labels")
            if not isinstance(scores, dict) or set(scores) != set(spec.labels):
                raise ValueError("unverified model score labels")
            if (any(type(v) not in (int, float) or not math.isfinite(v)
                    or not 0 <= v <= 1 for v in scores.values())
                    or abs(sum(scores.values())-1) > .002):
                raise ValueError("unverified model probabilities")
            predicted = max(spec.labels, key=lambda label: scores[label])
            matrix[(identity[0], name, revision)][(truth, predicted)] += 1
    reports = []
    for (source, name, revision), confusion in sorted(matrix.items()):
        labels = MODELS[name].labels
        support = sum(confusion.values())
        by_class = {}
        for label in labels:
            tp = confusion[(label, label)]
            fp = sum(v for (actual, pred), v in confusion.items() if pred == label and actual != label)
            fn = sum(v for (actual, pred), v in confusion.items() if actual == label and pred != label)
            precision = tp / (tp + fp) if tp + fp else 0.0
            recall = tp / (tp + fn) if tp + fn else 0.0
            score = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
            by_class[label] = {
                "support": tp + fn, "precision": round(precision, 6),
                "recall": round(recall, 6), "f1": round(score, 6),
            }
        expected_count = expected[(source, name)]
        reports.append({
            "source": source, "model_key": name, "model_revision": revision,
            "task": MODELS[name].task,
            "matched": support, "gold_count": expected_count,
            "coverage": round(support / expected_count, 6),
            "macro_f1_on_matched": round(sum(x["f1"] for x in by_class.values()) / len(labels), 6),
            "per_class": by_class, "metric_scope": "manually_labelled_messages_only",
        })
    # Missing model predictions must be reported, not hidden by omission.
    present = {(s, m) for (s, m, _revision) in matrix}
    for (source, name), expected_count in sorted(expected.items()):
        if (source, name) not in present:
            reports.append({
                "source": source, "model_key": name, "model_revision": None,
                "task": MODELS[name].task, "matched": 0,
                "gold_count": expected_count, "coverage": 0.0,
                "macro_f1_on_matched": None, "per_class": {},
                "metric_scope": "manually_labelled_messages_only",
            })
    return sorted(reports, key=lambda x: (
        x["source"], x["model_key"], x["model_revision"] or ""
    ))


def run(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Evaluate existing offline predictions against human labels")
    parser.add_argument("--predictions", required=True)
    parser.add_argument("--gold", required=True)
    args = parser.parse_args(argv)
    try:
        for result in evaluate(_load(args.predictions), _load(args.gold)):
            print(json.dumps(result, sort_keys=True))
        return 0
    except Exception:
        # Raw model inputs or file paths could contain secrets.
        print("sentiment benchmark failed: validate local inputs and label schema",
              file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(run())
