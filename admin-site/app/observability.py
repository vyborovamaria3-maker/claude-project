from __future__ import annotations

import math
import threading
import time
from collections import Counter
from contextlib import nullcontext
from typing import Any, Callable

try:
    from opentelemetry import trace
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor
except ImportError:  # pragma: no cover - guarded by requirements in production
    trace = None
    OTLPSpanExporter = None
    Resource = None
    TracerProvider = None
    BatchSpanProcessor = None


_BUCKETS = (0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0)
_PROVIDER_LOCK = threading.Lock()
_PROVIDER_CONFIGURED = False


class Observability:
    def __init__(self, *, service_name: str, environment: str, otlp_endpoint: str = "") -> None:
        self.service_name = service_name
        self.environment = environment
        self._lock = threading.Lock()
        self._requests: Counter[tuple[str, str, int]] = Counter()
        self._latency_buckets: Counter[tuple[str, str, float]] = Counter()
        self._latency_count: Counter[tuple[str, str]] = Counter()
        self._latency_sum: Counter[tuple[str, str]] = Counter()
        self._tracer = self._configure_tracing(otlp_endpoint.strip())

    def span(self, name: str, *, attributes: dict[str, Any] | None = None):
        if self._tracer is None:
            return nullcontext()
        return self._tracer.start_as_current_span(name, attributes=attributes or {})

    def record_request(self, *, method: str, path: str, status_code: int, duration_seconds: float) -> None:
        method = method.upper()[:16]
        path = _normalized_path(path)
        duration = max(0.0, float(duration_seconds))
        with self._lock:
            self._requests[(method, path, int(status_code))] += 1
            self._latency_count[(method, path)] += 1
            self._latency_sum[(method, path)] += duration
            for bucket in _BUCKETS:
                if duration <= bucket:
                    self._latency_buckets[(method, path, bucket)] += 1

    def render_prometheus(self, *, queue_metrics: Callable[[], dict[str, Any]] | None = None) -> str:
        lines = [
            "# HELP potapoff_admin_http_requests_total Total HTTP requests.",
            "# TYPE potapoff_admin_http_requests_total counter",
        ]
        with self._lock:
            requests = list(self._requests.items())
            bucket_rows = list(self._latency_buckets.items())
            count_rows = list(self._latency_count.items())
            sum_rows = list(self._latency_sum.items())
        for (method, path, code), value in sorted(requests):
            lines.append(
                f'potapoff_admin_http_requests_total{{method="{_escape(method)}",path="{_escape(path)}",code="{code}"}} {value}'
            )
        lines += [
            "# HELP potapoff_admin_http_request_duration_seconds HTTP request duration.",
            "# TYPE potapoff_admin_http_request_duration_seconds histogram",
        ]
        for (method, path, bucket), value in sorted(bucket_rows):
            lines.append(
                f'potapoff_admin_http_request_duration_seconds_bucket{{method="{_escape(method)}",path="{_escape(path)}",le="{bucket:g}"}} {value}'
            )
        for (method, path), value in sorted(count_rows):
            lines.append(
                f'potapoff_admin_http_request_duration_seconds_bucket{{method="{_escape(method)}",path="{_escape(path)}",le="+Inf"}} {value}'
            )
            lines.append(
                f'potapoff_admin_http_request_duration_seconds_count{{method="{_escape(method)}",path="{_escape(path)}"}} {value}'
            )
        for (method, path), value in sorted(sum_rows):
            if math.isfinite(value):
                lines.append(
                    f'potapoff_admin_http_request_duration_seconds_sum{{method="{_escape(method)}",path="{_escape(path)}"}} {value:.9f}'
                )
        if queue_metrics is not None:
            metrics = queue_metrics()
            lines += [
                "# HELP potapoff_admin_task_queue_depth Queued background tasks.",
                "# TYPE potapoff_admin_task_queue_depth gauge",
                f"potapoff_admin_task_queue_depth {int(metrics.get('queue_depth', 0))}",
                "# HELP potapoff_admin_task_workers_alive Live background workers.",
                "# TYPE potapoff_admin_task_workers_alive gauge",
                f"potapoff_admin_task_workers_alive {int(metrics.get('workers_alive', 0))}",
            ]
            for state in ("queued", "running", "completed", "failed"):
                lines.append(f'potapoff_admin_tasks{{state="{state}"}} {int(metrics.get(state, 0))}')
        return "\n".join(lines) + "\n"

    def _configure_tracing(self, endpoint: str):
        if trace is None:
            return None
        global _PROVIDER_CONFIGURED
        if endpoint and all((TracerProvider, Resource, BatchSpanProcessor, OTLPSpanExporter)):
            with _PROVIDER_LOCK:
                if not _PROVIDER_CONFIGURED:
                    provider = TracerProvider(
                        resource=Resource.create(
                            {
                                "service.name": self.service_name,
                                "deployment.environment.name": self.environment,
                            }
                        )
                    )
                    exporter = OTLPSpanExporter(endpoint=endpoint)
                    provider.add_span_processor(BatchSpanProcessor(exporter))
                    trace.set_tracer_provider(provider)
                    _PROVIDER_CONFIGURED = True
        return trace.get_tracer("potapoff.admin")


def _normalized_path(path: str) -> str:
    if path.startswith("/api/analysis-tasks/"):
        return "/api/analysis-tasks/{task_id}"
    if len(path) > 160:
        return path[:160]
    return path


def _escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')


def monotonic() -> float:
    return time.monotonic()
