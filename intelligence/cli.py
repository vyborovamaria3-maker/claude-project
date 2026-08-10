"""Operational CLI for the isolated POTAPoff intelligence runtime."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import sys
from collections.abc import Callable, Sequence
from datetime import datetime
from pathlib import Path
from typing import Any

from intelligence.bootstrap import IntelligenceRuntime, build_sqlite_runtime
from intelligence.errors.exceptions import IntelligenceError
from intelligence.health.doctor import run_registry_health_check, summarize_health
from intelligence.security.sanitizer import sanitize_payload, sanitize_text
from intelligence.worker.queue import IntelligenceJob


DEFAULT_DB_PATH = "/var/lib/potapoff-intelligence/intelligence.sqlite3"
RuntimeFactory = Callable[[str | Path], IntelligenceRuntime]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="potapoff-intelligence")
    parser.add_argument(
        "--db",
        default=os.getenv("POTAPOFF_INTELLIGENCE_DB", DEFAULT_DB_PATH),
        help="SQLite runtime database path",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("doctor", help="Check all configured intelligence providers")

    enqueue = subparsers.add_parser("enqueue", help="Queue one intelligence collection job")
    enqueue.add_argument("provider", help="Registered provider name")
    enqueue.add_argument("query", help="Provider query or URL")

    run_once = subparsers.add_parser("run-once", help="Claim and execute one queued job")
    run_once.set_defaults(command="run-once")

    worker = subparsers.add_parser("worker", help="Run the durable worker loop")
    worker.add_argument("--poll-seconds", type=float, default=2.0)

    job = subparsers.add_parser("job", help="Show one job")
    job.add_argument("job_id")

    documents = subparsers.add_parser("documents", help="List normalized evidence metadata")
    documents.add_argument("--limit", type=int, default=100)

    return parser


def _json_default(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    raise TypeError(f"unsupported JSON value: {type(value).__name__}")


def _emit(payload: Any, *, stream: Any = None) -> None:
    output = stream or sys.stdout
    safe = sanitize_payload(payload)
    print(json.dumps(safe, ensure_ascii=False, sort_keys=True, default=_json_default), file=output)


def _job_payload(job: IntelligenceJob) -> dict[str, Any]:
    return {
        "id": job.id,
        "status": job.status.value,
        "created_at": job.created_at,
        "started_at": job.started_at,
        "finished_at": job.finished_at,
        "result_document_ids": list(job.result_document_ids),
        "error": sanitize_text(job.error) if job.error else None,
        "payload": sanitize_payload(job.payload),
    }


async def _doctor(runtime: IntelligenceRuntime) -> int:
    results = await run_registry_health_check(runtime.registry)
    summary = summarize_health(results)
    _emit(summary)
    return 0 if summary["all_healthy"] else 1


async def _run_once(runtime: IntelligenceRuntime) -> int:
    job = await runtime.worker.run_next()
    if job is None:
        _emit({"idle": True})
        return 0
    _emit(_job_payload(job))
    return 0 if job.status.value == "completed" else 1


async def _worker_loop(runtime: IntelligenceRuntime, poll_seconds: float) -> int:
    if poll_seconds < 0.1 or poll_seconds > 3600:
        raise ValueError("poll-seconds must be between 0.1 and 3600")

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    installed_signals: list[signal.Signals] = []
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
            installed_signals.append(sig)
        except (NotImplementedError, RuntimeError):
            pass

    try:
        while not stop.is_set():
            job = await runtime.worker.run_next()
            if job is None:
                try:
                    await asyncio.wait_for(stop.wait(), timeout=poll_seconds)
                except asyncio.TimeoutError:
                    pass
                continue
            _emit({"id": job.id, "status": job.status.value})
        return 0
    finally:
        for sig in installed_signals:
            try:
                loop.remove_signal_handler(sig)
            except (NotImplementedError, RuntimeError):
                pass


def _documents(runtime: IntelligenceRuntime, limit: int) -> int:
    if limit < 1 or limit > 1000:
        raise ValueError("limit must be between 1 and 1000")
    documents = runtime.store.list_all()
    selected = documents[-limit:]
    _emit(
        {
            "count": len(selected),
            "documents": [
                {
                    "id": document.id,
                    "source": document.source,
                    "provider": document.provider,
                    "url": document.url,
                    "author": document.author,
                    "published_at": document.published_at,
                    "collected_at": document.collected_at,
                    "entities": document.entities,
                    "metrics": document.metrics,
                    "raw_hash": document.raw_hash,
                }
                for document in selected
            ],
        }
    )
    return 0


def main(
    argv: Sequence[str] | None = None,
    *,
    runtime_factory: RuntimeFactory = build_sqlite_runtime,
) -> int:
    parser = build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)

    try:
        with runtime_factory(args.db) as runtime:
            if args.command == "doctor":
                return asyncio.run(_doctor(runtime))
            if args.command == "enqueue":
                job = runtime.queue.submit({"provider": args.provider, "query": args.query})
                _emit({"id": job.id, "status": job.status.value, "provider": args.provider})
                return 0
            if args.command == "run-once":
                return asyncio.run(_run_once(runtime))
            if args.command == "worker":
                return asyncio.run(_worker_loop(runtime, args.poll_seconds))
            if args.command == "job":
                job = runtime.queue.get(args.job_id)
                if job is None:
                    _emit({"error": "job_not_found"}, stream=sys.stderr)
                    return 1
                _emit(_job_payload(job))
                return 0
            if args.command == "documents":
                return _documents(runtime, args.limit)
    except (IntelligenceError, ValueError) as exc:
        _emit({"error": sanitize_text(str(exc))[:500] or exc.__class__.__name__}, stream=sys.stderr)
        return 2

    _emit({"error": "unsupported_command"}, stream=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
