from __future__ import annotations

from time import monotonic, time

from celery import Celery, signals

from app.core.config import get_settings
from app.services.observability import CELERY_QUEUE_WAIT, CELERY_TASK_RUNTIME

settings = get_settings()

KNOWN_QUEUES = {"maintenance", "market", "social", "blockchain", "intelligence"}
_ENQUEUED_AT_HEADER = "potapoff_enqueued_at"
_TASK_STARTED_ATTR = "_potapoff_started_monotonic"
_TASK_QUEUE_ATTR = "_potapoff_queue"


def _normalized_queue(value: object) -> str:
    queue = str(value or "").strip()
    return queue if queue in KNOWN_QUEUES else "unknown"


def _normalized_result(value: object) -> str:
    result = str(value or "unknown").strip().lower()
    return result if result in {"success", "failure", "retry", "revoked"} else "other"


@signals.before_task_publish.connect
def _stamp_published_task(headers=None, **_kwargs) -> None:
    if isinstance(headers, dict):
        headers[_ENQUEUED_AT_HEADER] = time()


@signals.task_prerun.connect
def _observe_task_start(task=None, **_kwargs) -> None:
    if task is None:
        return
    request = task.request
    delivery_info = getattr(request, "delivery_info", None) or {}
    queue = _normalized_queue(delivery_info.get("routing_key"))
    setattr(request, _TASK_QUEUE_ATTR, queue)
    setattr(request, _TASK_STARTED_ATTR, monotonic())

    headers = getattr(request, "headers", None) or {}
    raw_enqueued_at = headers.get(_ENQUEUED_AT_HEADER)
    try:
        enqueued_at = float(raw_enqueued_at)
    except (TypeError, ValueError):
        return
    CELERY_QUEUE_WAIT.labels(queue=queue).observe(max(0.0, time() - enqueued_at))


@signals.task_postrun.connect
def _observe_task_finish(task=None, state=None, **_kwargs) -> None:
    if task is None:
        return
    request = task.request
    started = getattr(request, _TASK_STARTED_ATTR, None)
    if started is None:
        return
    try:
        elapsed = max(0.0, monotonic() - float(started))
    except (TypeError, ValueError):
        return
    queue = _normalized_queue(getattr(request, _TASK_QUEUE_ATTR, "unknown"))
    CELERY_TASK_RUNTIME.labels(
        queue=queue,
        result=_normalized_result(state),
    ).observe(elapsed)


celery_app = Celery(
    "potapoff",
    broker=settings.celery_broker_url,
    backend=settings.celery_result_backend,
    include=[
        "app.tasks.notifications",
        "app.tasks.etl",
        "app.tasks.intelligence",
        "app.tasks.advanced_intelligence",
        "app.tasks.social",
    ],
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    task_default_queue="maintenance",
    task_routes={
        "app.tasks.etl.collect_tokens": {"queue": "market"},
        "app.tasks.etl.refresh_metrics": {"queue": "market"},
        "app.tasks.etl.refresh_links": {"queue": "blockchain"},
        "app.tasks.etl.run_full_collection": {"queue": "market"},
        "app.tasks.etl.bootstrap_jobs": {"queue": "maintenance"},
        "app.tasks.social.refresh_x": {"queue": "social"},
        "app.tasks.intelligence.evaluate_matured_outcomes": {"queue": "intelligence"},
        "app.tasks.advanced_intelligence.enrich_report": {"queue": "intelligence"},
        "app.tasks.notifications.*": {"queue": "maintenance"},
    },
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    worker_prefetch_multiplier=1,
    beat_schedule={
        "collect-pumpfun-tokens-every-5-minutes": {
            "task": "app.tasks.etl.collect_tokens",
            "schedule": 300.0,
        },
        "refresh-token-metrics-hourly": {
            "task": "app.tasks.etl.refresh_metrics",
            "schedule": 3600.0,
        },
        "refresh-insider-links-daily": {
            "task": "app.tasks.etl.refresh_links",
            "schedule": 86400.0,
        },
        "bootstrap-collector-jobs": {
            "task": "app.tasks.etl.bootstrap_jobs",
            "schedule": 900.0,
        },
        "evaluate-intelligence-outcomes-every-15-minutes": {
            "task": "app.tasks.intelligence.evaluate_matured_outcomes",
            "schedule": 900.0,
        },
    },
)
