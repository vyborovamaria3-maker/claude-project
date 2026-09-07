from __future__ import annotations

import argparse
import asyncio
import copy
import json
import os
from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path
from time import perf_counter
from typing import Any

import httpx


@dataclass(slots=True)
class PipelineSample:
    preliminary_ms: float
    final_ms: float
    submit_status: int | None
    final_status: str | None
    cached: bool = False
    reused_job: bool = False
    error: str | None = None


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = max(
        0,
        min(len(ordered) - 1, int(round((len(ordered) - 1) * percentile))),
    )
    return ordered[index]


def _latency_summary(values: list[float]) -> dict[str, float]:
    if not values:
        return {"min": 0.0, "p50": 0.0, "p95": 0.0, "p99": 0.0, "max": 0.0, "avg": 0.0}
    return {
        "min": round(min(values), 2),
        "p50": round(_percentile(values, 0.50), 2),
        "p95": round(_percentile(values, 0.95), 2),
        "p99": round(_percentile(values, 0.99), 2),
        "max": round(max(values), 2),
        "avg": round(sum(values) / len(values), 2),
    }


def _load_payload(path: str) -> dict[str, Any]:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise SystemExit("snapshot JSON must contain an object")
    if isinstance(raw.get("snapshot"), dict):
        payload = copy.deepcopy(raw)
    else:
        payload = {"snapshot": copy.deepcopy(raw)}
    if not isinstance(payload.get("snapshot"), dict):
        raise SystemExit("payload.snapshot must be an object")
    return payload


def _request_payload(
    template: dict[str, Any],
    index: int,
    *,
    reuse_identical_request: bool,
    persist: bool,
    enrich: bool,
) -> dict[str, Any]:
    payload = copy.deepcopy(template)
    snapshot = payload["snapshot"]
    if not reuse_identical_request:
        base_snapshot_id = str(snapshot.get("snapshotId") or "benchmark-snapshot")
        snapshot["snapshotId"] = f"{base_snapshot_id}-bench-{index}"
    payload["persist"] = persist
    payload["enrich"] = enrich
    payload.setdefault("role", "analyst")
    return payload


async def _run_one(
    client: httpx.AsyncClient,
    args: argparse.Namespace,
    template: dict[str, Any],
    index: int,
) -> PipelineSample:
    payload = _request_payload(
        template,
        index,
        reuse_identical_request=args.reuse_identical_request,
        persist=args.persist,
        enrich=not args.no_enrich,
    )
    started = perf_counter()
    try:
        response = await client.post(args.submit_path, json=payload)
        preliminary_ms = (perf_counter() - started) * 1000
    except Exception as exc:
        elapsed = (perf_counter() - started) * 1000
        return PipelineSample(
            preliminary_ms=elapsed,
            final_ms=elapsed,
            submit_status=None,
            final_status=None,
            error=type(exc).__name__,
        )

    try:
        body = response.json()
    except ValueError:
        body = {}
    if not isinstance(body, dict):
        body = {}

    if response.status_code == 200 and body.get("status") == "completed":
        return PipelineSample(
            preliminary_ms=preliminary_ms,
            final_ms=(perf_counter() - started) * 1000,
            submit_status=response.status_code,
            final_status="completed",
            cached=bool(body.get("cached")),
        )
    if response.status_code != 202:
        return PipelineSample(
            preliminary_ms=preliminary_ms,
            final_ms=(perf_counter() - started) * 1000,
            submit_status=response.status_code,
            final_status=None,
            error=f"submit_http_{response.status_code}",
        )

    job_id = str(body.get("job_id") or "")
    if not job_id:
        return PipelineSample(
            preliminary_ms=preliminary_ms,
            final_ms=(perf_counter() - started) * 1000,
            submit_status=response.status_code,
            final_status=None,
            reused_job=bool(body.get("reused_job")),
            error="missing_job_id",
        )

    deadline = perf_counter() + args.final_timeout_seconds
    final_status: str | None = None
    while perf_counter() < deadline:
        await asyncio.sleep(args.poll_interval_seconds)
        try:
            poll = await client.get(f"{args.jobs_path.rstrip('/')}/{job_id}")
        except Exception as exc:
            return PipelineSample(
                preliminary_ms=preliminary_ms,
                final_ms=(perf_counter() - started) * 1000,
                submit_status=response.status_code,
                final_status=final_status,
                reused_job=bool(body.get("reused_job")),
                error=f"poll_{type(exc).__name__}",
            )
        if poll.status_code != 200:
            continue
        try:
            state = poll.json()
        except ValueError:
            continue
        if not isinstance(state, dict):
            continue
        final_status = str(state.get("status") or "") or None
        if final_status in {"completed", "failed"}:
            return PipelineSample(
                preliminary_ms=preliminary_ms,
                final_ms=(perf_counter() - started) * 1000,
                submit_status=response.status_code,
                final_status=final_status,
                reused_job=bool(body.get("reused_job")),
                error=(str(state.get("error") or "")[:120] if final_status == "failed" else None),
            )

    return PipelineSample(
        preliminary_ms=preliminary_ms,
        final_ms=(perf_counter() - started) * 1000,
        submit_status=response.status_code,
        final_status=final_status,
        reused_job=bool(body.get("reused_job")),
        error="final_timeout",
    )


async def _run(args: argparse.Namespace) -> dict[str, Any]:
    backend_key = args.backend_api_key or os.getenv("POTAPOFF_BENCH_BACKEND_API_KEY", "")
    if not backend_key:
        raise SystemExit("provide --backend-api-key or POTAPOFF_BENCH_BACKEND_API_KEY")
    if args.persist and not args.allow_persistence:
        raise SystemExit("--persist requires --allow-persistence and should only be used in staging")

    template = _load_payload(args.snapshot_json)
    headers = {"X-Backend-API-Key": backend_key}
    limits = httpx.Limits(
        max_connections=max(args.concurrency, 10),
        max_keepalive_connections=max(args.concurrency, 10),
    )
    timeout = httpx.Timeout(args.http_timeout_seconds)
    samples: list[PipelineSample] = []
    next_index = 0
    index_lock = asyncio.Lock()

    async with httpx.AsyncClient(
        base_url=args.base_url.rstrip("/"),
        headers=headers,
        limits=limits,
        timeout=timeout,
    ) as client:
        async def worker() -> None:
            nonlocal next_index
            while True:
                async with index_lock:
                    if next_index >= args.requests:
                        return
                    index = next_index
                    next_index += 1
                samples.append(await _run_one(client, args, template, index))

        started = perf_counter()
        await asyncio.gather(*(worker() for _ in range(args.concurrency)))
        elapsed = perf_counter() - started

    preliminary = [row.preliminary_ms for row in samples if row.submit_status is not None]
    completed = [row.final_ms for row in samples if row.final_status == "completed"]
    submit_statuses = Counter(str(row.submit_status) for row in samples if row.submit_status is not None)
    final_statuses = Counter(str(row.final_status) for row in samples if row.final_status)
    errors = Counter(row.error for row in samples if row.error)
    return {
        "scenario": "advanced-async-pipeline",
        "base_url": args.base_url,
        "requests": args.requests,
        "concurrency": args.concurrency,
        "persist": args.persist,
        "enrich": not args.no_enrich,
        "reuse_identical_request": args.reuse_identical_request,
        "elapsed_seconds": round(elapsed, 3),
        "throughput_requests_per_second": round(args.requests / elapsed, 3) if elapsed else 0.0,
        "preliminary_latency_ms": _latency_summary(preliminary),
        "final_completed_latency_ms": _latency_summary(completed),
        "submit_status_codes": dict(sorted(submit_statuses.items())),
        "final_statuses": dict(sorted(final_statuses.items())),
        "cached_responses": sum(1 for row in samples if row.cached),
        "singleflight_reused_jobs": sum(1 for row in samples if row.reused_job),
        "errors": dict(errors.most_common(10)),
        "samples": [asdict(row) for row in samples] if args.include_samples else None,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Measure preliminary and final latency of POTAPoff async advanced intelligence.",
    )
    parser.add_argument("--snapshot-json", required=True)
    parser.add_argument(
        "--base-url",
        default=os.getenv("POTAPOFF_BENCH_URL", "http://127.0.0.1:8000"),
    )
    parser.add_argument("--backend-api-key", default=None)
    parser.add_argument(
        "--submit-path",
        default="/api/v1/social/intelligence/advanced/report/async",
    )
    parser.add_argument(
        "--jobs-path",
        default="/api/v1/social/intelligence/advanced/report/jobs",
    )
    parser.add_argument("--requests", type=int, default=50)
    parser.add_argument("--concurrency", type=int, default=5)
    parser.add_argument("--http-timeout-seconds", type=float, default=30.0)
    parser.add_argument("--final-timeout-seconds", type=float, default=180.0)
    parser.add_argument("--poll-interval-seconds", type=float, default=0.25)
    parser.add_argument("--reuse-identical-request", action="store_true")
    parser.add_argument("--no-enrich", action="store_true")
    parser.add_argument("--persist", action="store_true")
    parser.add_argument("--allow-persistence", action="store_true")
    parser.add_argument("--include-samples", action="store_true")
    parser.add_argument("--json-out", default=None)
    return parser


def main() -> None:
    args = _parser().parse_args()
    if args.requests < 1 or args.concurrency < 1:
        raise SystemExit("--requests and --concurrency must be >= 1")
    if args.poll_interval_seconds <= 0 or args.final_timeout_seconds <= 0:
        raise SystemExit("poll/final timeouts must be > 0")

    result = asyncio.run(_run(args))
    rendered = json.dumps(result, indent=2, sort_keys=True)
    print(rendered)
    if args.json_out:
        Path(args.json_out).write_text(rendered + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
