from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
from collections import Counter
from dataclasses import asdict, dataclass
from time import perf_counter
from typing import Iterable

import httpx

READ_SCENARIOS = {"tokens", "wallet", "telegram-token"}
WRITE_SCENARIOS = {"telegram-evaluate", "collector"}
ALL_SCENARIOS = READ_SCENARIOS | WRITE_SCENARIOS


@dataclass(slots=True)
class Sample:
    latency_ms: float
    status_code: int | None
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


def _summary(samples: Iterable[Sample], elapsed_seconds: float) -> dict:
    rows = list(samples)
    http_rows = [row for row in rows if row.error is None and row.status_code is not None]
    successful = [
        row
        for row in http_rows
        if row.status_code is not None and 200 <= row.status_code < 400
    ]
    latencies = [row.latency_ms for row in http_rows]
    statuses = Counter(str(row.status_code) for row in rows if row.status_code is not None)
    errors = Counter(row.error for row in rows if row.error)
    return {
        "requests": len(rows),
        "http_responses": len(http_rows),
        "successful_2xx_3xx": len(successful),
        "failed_http_responses": len(http_rows) - len(successful),
        "transport_errors": sum(errors.values()),
        "elapsed_seconds": round(elapsed_seconds, 4),
        "requests_per_second": (
            round(len(rows) / elapsed_seconds, 2) if elapsed_seconds else 0.0
        ),
        "latency_ms": {
            "min": round(min(latencies), 2) if latencies else 0.0,
            "p50": round(_percentile(latencies, 0.50), 2),
            "p95": round(_percentile(latencies, 0.95), 2),
            "p99": round(_percentile(latencies, 0.99), 2),
            "max": round(max(latencies), 2) if latencies else 0.0,
            "avg": round(sum(latencies) / len(latencies), 2) if latencies else 0.0,
        },
        "status_codes": dict(sorted(statuses.items())),
        "transport_error_types": dict(errors.most_common(10)),
    }


def _target(args: argparse.Namespace) -> tuple[str, str]:
    api = args.api_prefix.rstrip("/")
    if args.scenario == "tokens":
        max_offset = max(0, args.dataset_size - args.page_size)
        offset = random.randint(0, max_offset) if args.random_offsets and max_offset else 0
        return (
            "GET",
            f"{api}/analytics/tokens?sort_by={args.sort_by}&order=desc"
            f"&limit={args.page_size}&offset={offset}",
        )
    if args.scenario == "wallet":
        if not args.wallet:
            raise ValueError("--wallet is required for the wallet scenario")
        max_offset = max(0, args.dataset_size - args.page_size)
        offset = random.randint(0, max_offset) if args.random_offsets and max_offset else 0
        return (
            "GET",
            f"{api}/analytics/wallets/{args.wallet}/activity"
            f"?limit={args.page_size}&offset={offset}",
        )
    if args.scenario == "telegram-token":
        if not args.mint:
            raise ValueError("--mint is required for the telegram-token scenario")
        return "GET", f"{api}/telegram/token/{args.mint}?limit={args.page_size}"
    if args.scenario == "telegram-evaluate":
        return (
            "POST",
            f"{api}/telegram/calls/evaluate?limit={args.evaluation_limit}"
            f"&window_hours={args.window_hours}",
        )
    if args.scenario == "collector":
        return "POST", f"{api}/analytics/collector/run"
    raise ValueError(f"unknown scenario: {args.scenario}")


async def _request_once(
    client: httpx.AsyncClient,
    args: argparse.Namespace,
) -> Sample:
    method, path = _target(args)
    started = perf_counter()
    try:
        response = await client.request(method, path)
        latency_ms = (perf_counter() - started) * 1000
        return Sample(latency_ms=latency_ms, status_code=response.status_code)
    except Exception as exc:
        latency_ms = (perf_counter() - started) * 1000
        return Sample(
            latency_ms=latency_ms,
            status_code=None,
            error=type(exc).__name__,
        )


async def _run(args: argparse.Namespace) -> dict:
    if args.scenario in WRITE_SCENARIOS and not args.allow_write_scenarios:
        raise SystemExit(
            f"{args.scenario} changes server state. Re-run with --allow-write-scenarios "
            "only against a staging/load-test environment."
        )
    if args.scenario == "collector" and (args.requests != 1 or args.concurrency != 1):
        raise SystemExit(
            "collector is intentionally restricted to --requests 1 --concurrency 1"
        )

    token = args.token or os.getenv("POTAPOFF_BENCH_TOKEN", "")
    if not token:
        raise SystemExit("provide --token or POTAPOFF_BENCH_TOKEN")

    headers = {"Authorization": f"Bearer {token}"}
    timeout = httpx.Timeout(args.timeout_seconds)
    limits = httpx.Limits(
        max_connections=max(args.concurrency, 10),
        max_keepalive_connections=max(args.concurrency, 10),
    )
    samples: list[Sample] = []
    next_index = 0
    index_lock = asyncio.Lock()

    async with httpx.AsyncClient(
        base_url=args.base_url.rstrip("/"),
        headers=headers,
        timeout=timeout,
        limits=limits,
        http2=args.http2,
    ) as client:
        for _ in range(args.warmup_requests):
            await _request_once(client, args)

        async def worker() -> None:
            nonlocal next_index
            while True:
                async with index_lock:
                    if next_index >= args.requests:
                        return
                    next_index += 1
                samples.append(await _request_once(client, args))

        started = perf_counter()
        await asyncio.gather(*(worker() for _ in range(args.concurrency)))
        elapsed = perf_counter() - started

    result = {
        "scenario": args.scenario,
        "base_url": args.base_url,
        "concurrency": args.concurrency,
        "offset_range_hint": args.dataset_size,
        "random_offsets": args.random_offsets,
        "summary": _summary(samples, elapsed),
    }
    if args.include_samples:
        result["samples"] = [asdict(sample) for sample in samples]
    return result


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Small dependency-free HTTP load harness for POTAPoff hot paths.",
    )
    parser.add_argument("scenario", choices=sorted(ALL_SCENARIOS))
    parser.add_argument(
        "--base-url",
        default=os.getenv("POTAPOFF_BENCH_URL", "http://127.0.0.1:8000"),
    )
    parser.add_argument("--api-prefix", default="/api/v1")
    parser.add_argument(
        "--token",
        default=None,
        help="Bearer token; prefer POTAPOFF_BENCH_TOKEN",
    )
    parser.add_argument("--requests", type=int, default=500)
    parser.add_argument("--concurrency", type=int, default=25)
    parser.add_argument("--warmup-requests", type=int, default=10)
    parser.add_argument("--timeout-seconds", type=float, default=30.0)
    parser.add_argument("--dataset-size", type=int, default=10_000)
    parser.add_argument("--page-size", type=int, default=50)
    parser.add_argument(
        "--sort-by",
        choices=("ath", "volume", "liquidity", "market_cap", "holders"),
        default="volume",
    )
    parser.add_argument("--random-offsets", action="store_true")
    parser.add_argument("--wallet", default=None)
    parser.add_argument("--mint", default=None)
    parser.add_argument("--evaluation-limit", type=int, default=1000)
    parser.add_argument("--window-hours", type=int, default=72)
    parser.add_argument("--allow-write-scenarios", action="store_true")
    parser.add_argument("--http2", action="store_true")
    parser.add_argument("--include-samples", action="store_true")
    parser.add_argument("--json-out", default=None)
    return parser


def main() -> None:
    args = _parser().parse_args()
    if args.requests < 1 or args.concurrency < 1:
        raise SystemExit("--requests and --concurrency must be >= 1")
    if args.page_size < 1 or args.page_size > 250:
        raise SystemExit("--page-size must be between 1 and 250")
    if args.dataset_size < 1:
        raise SystemExit("--dataset-size must be >= 1")

    result = asyncio.run(_run(args))
    rendered = json.dumps(result, indent=2, sort_keys=True)
    print(rendered)
    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as handle:
            handle.write(rendered + "\n")


if __name__ == "__main__":
    main()
