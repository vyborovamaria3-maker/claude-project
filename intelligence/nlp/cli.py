"""Bounded offline local inference from JSONL or read-only X/TG PostgreSQL.

AI work has lower OS process priority than collectors, awaits RAM headroom,
and commits each completed mini-batch before moving to the next. SIGINT and
SIGTERM are graceful between mini-batches and after an in-flight inference.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import threading
from contextlib import contextmanager
from datetime import datetime
from typing import Any, Iterator

from intelligence.nlp.sentiment import LocalTransformersBackend, SentimentEngine, SourceText
from intelligence.nlp.resources import ResourceController, ResourcePressure


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


@contextmanager
def _graceful_signals(stop: threading.Event) -> Iterator[None]:
    """Request a stop without interrupting a current model/SQLite commit."""
    previous: dict[signal.Signals, Any] = {}
    if threading.current_thread() is threading.main_thread():
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                old = signal.getsignal(sig)
                signal.signal(sig, lambda _s, _f: stop.set())
                previous[sig] = old
            except (OSError, ValueError, AttributeError):
                pass
    try:
        yield
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def _process_in_chunks(
    engine: SentimentEngine, items: list[SourceText], *,
    batch_size: int, results_db: str | None, stop: threading.Event,
) -> int:
    """Save each complete mini-batch atomically, even if a later one fails."""
    from intelligence.nlp.results_store import store_predictions
    for offset in range(0, len(items), batch_size):
        if stop.is_set():
            return 130
        # Fake test backends do not require psutil; real backend always applies
        # the guard again immediately before model execution.
        backend = engine.backend
        if isinstance(backend, LocalTransformersBackend):
            if not backend.resources.wait_for_capacity(unload=backend.unload_all):
                return 130
        results = engine.analyze(items[offset:offset + batch_size])
        if results_db:
            store_predictions(results_db, results)
        for result in results:
            print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        # Stop after a successfully committed batch, not mid-inference.
        if stop.is_set():
            return 130
    return 0


def run(argv: list[str] | None = None, *, stop_event: threading.Event | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Offline-only X/TG sentiment: models must be prefetched on this laptop"
    )
    parser.add_argument("--batch-size", type=int,
                        default=int(os.getenv("SENTIMENT_BATCH_SIZE", "2")))
    parser.add_argument("--max-items", type=int, default=20)
    parser.add_argument("--device", default=os.getenv("SENTIMENT_DEVICE", "cpu"),
                        help="cpu or cuda:0")
    parser.add_argument("--max-loaded-models", type=int,
                        default=int(os.getenv("SENTIMENT_MAX_LOADED_MODELS", "1")),
                        help="resident model cache limit, 1..3; default 1")
    parser.add_argument("--results-db", default=None,
                        help="separate absolute SQLite file for durable derived probabilities")
    parser.add_argument("--summary-as-of", default=None,
                        help="read-only derived model averages as of ISO timestamp")
    parser.add_argument("--summary-source", choices=("x", "tg"), default=None)
    parser.add_argument("--collector-db", choices=("x", "tg"),
                        help="bounded latest source text from read-only PostgreSQL")
    parser.add_argument("--check-config", action="store_true",
                        help="check SHA revisions without weights, DB or RAM probes")
    args = parser.parse_args(argv)
    stop = stop_event if stop_event is not None else threading.Event()
    try:
        if not 1 <= args.max_items <= 1000 or not 1 <= args.batch_size <= 32:
            raise ValueError("batch-size or max-items out of bounds")
        if args.summary_as_of:
            if args.collector_db or not args.results_db:
                raise ValueError("summary requires a standalone --results-db only")
            from intelligence.nlp.summary import summarize_as_of
            for item in summarize_as_of(args.results_db, _parse_date(args.summary_as_of),
                                        source=args.summary_source):
                print(json.dumps(item, sort_keys=True))
            return 0
        if args.summary_source:
            raise ValueError("--summary-source requires --summary-as-of")
        guard = ResourceController(stop=stop)
        backend = LocalTransformersBackend(
            device=args.device, max_loaded_models=args.max_loaded_models,
            resources=guard,
        )
        engine = SentimentEngine.from_environment(backend=backend)
        # CLI --batch-size must govern both model tensor batches and commits.
        engine.batch_size = args.batch_size
        if args.check_config:
            print(json.dumps({
                "status": "revision_config_valid", "network_used": False,
                "models": {key: engine.revisions[key] for key in engine.revisions},
                "batch_size": engine.batch_size,
            }, sort_keys=True))
            return 0

        with _graceful_signals(stop):
            if stop.is_set():
                return 130
            if args.collector_db:
                if os.environ.get("SENTIMENT_SOURCE_READ_ENABLED") != "true":
                    raise ValueError("read-only source scan requires explicit opt-in")
                from intelligence.nlp.sources import read_collector_texts
                name = ("X_SOURCE_DATABASE_URL" if args.collector_db == "x"
                        else "TG_SOURCE_DATABASE_URL")
                items = read_collector_texts(
                    args.collector_db, dsn=os.environ.get(name, ""), limit=args.max_items
                )
            else:
                items = []
                # Bounded source input; never unbounded readlines() / API pagination.
                for line in sys.stdin:
                    if stop.is_set():
                        return 130
                    if len(line) > 25000:
                        raise ValueError("input line exceeds limit")
                    if not line.strip():
                        continue
                    if len(items) >= args.max_items:
                        raise ValueError("input item limit exceeded")
                    items.append(_source_text(json.loads(line)))
            result = _process_in_chunks(
                engine, items, batch_size=args.batch_size,
                results_db=args.results_db, stop=stop,
            )
            if result == 130:
                print("sentiment stopped; previously committed batches retained", file=sys.stderr)
            return result
    except ResourcePressure:
        print("sentiment deferred for laptop RAM/priority safety; committed batches retained",
              file=sys.stderr)
        return 2
    except Exception:
        # Do not echo third-party exceptions: they can contain text/credentials.
        print("sentiment inference failed; previously committed batches retained",
              file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(run())
