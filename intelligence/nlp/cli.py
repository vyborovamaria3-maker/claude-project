"""Explicit offline sentiment inference over bounded local X/TG JSONL input.

Input records:
{"source":"x","source_id":"x:tweet:123","text":"...","observed_at":"2026-10-20T00:00:00Z"}
{"source":"tg","source_id":"tg:message:-100123:456","text":"...","observed_at":"..."}
Output contains only identities, model probabilities, hashes and timestamps;
source message text never goes to stdout or traceback.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from typing import Any

from intelligence.nlp.sentiment import LocalTransformersBackend, SentimentEngine, SourceText


def _parse_date(value: Any) -> datetime:
    if not isinstance(value, str):
        raise ValueError("timestamp must be an ISO-8601 string")
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _source_text(record: Any) -> SourceText:
    if not isinstance(record, dict):
        raise ValueError("input item must be a JSON object")
    fields = ("source", "source_id", "text", "observed_at")
    if any(field not in record for field in fields):
        raise ValueError("missing required source/text/identity/timestamp fields")
    return SourceText(
        source=record["source"], source_id=record["source_id"], text=record["text"],
        observed_at=_parse_date(record["observed_at"]),
        occurred_at=(_parse_date(record["occurred_at"]) if
                     record.get("occurred_at") is not None else None),
    )


def run(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Offline-only X/TG sentiment: model weights must be prefetched locally"
    )
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--max-items", type=int, default=100)
    parser.add_argument("--device", default="cpu", help="cpu or cuda:0")
    parser.add_argument("--collector-db", choices=("x", "tg"),
                        help="read bounded latest messages from an existing read-only PG collector")
    parser.add_argument("--check-config", action="store_true",
                        help="validate model SHA revisions; do not load models or read stdin")
    args = parser.parse_args(argv)
    try:
        if not 1 <= args.max_items <= 1000 or not 1 <= args.batch_size <= 32:
            raise ValueError("invalid batch-size or max-items")
        engine = SentimentEngine.from_environment(
            backend=LocalTransformersBackend(device=args.device)
        )
        if args.check_config:
            print(json.dumps({
                "status": "revision_config_valid", "network_used": False,
                "models": {key: engine.revisions[key] for key in engine.revisions},
            }, sort_keys=True))
            return 0

        if args.collector_db:
            if os.environ.get("SENTIMENT_SOURCE_READ_ENABLED") != "true":
                raise ValueError("read-only collector scan requires explicit opt-in")
            from intelligence.nlp.sources import read_collector_texts
            name = "X_SOURCE_DATABASE_URL" if args.collector_db == "x" else "TG_SOURCE_DATABASE_URL"
            items = read_collector_texts(
                args.collector_db, dsn=os.environ.get(name, ""), limit=args.max_items
            )
        else:
            items = []
            # A bounded stream, not an unlimited readlines()/bulk provider fetch.
            for line in sys.stdin:
                if len(line) > 25000:
                    raise ValueError("input line exceeds limit")
                if not line.strip():
                    continue
                if len(items) >= args.max_items:
                    raise ValueError("input item limit exceeded")
                items.append(_source_text(json.loads(line)))
        for result in engine.analyze(items):
            print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except Exception:
        # Do not print a model exception: exception strings may contain
        # user messages, cache filesystem paths, or credentials.
        print("sentiment inference failed (check pinned models and local cache)", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(run())
