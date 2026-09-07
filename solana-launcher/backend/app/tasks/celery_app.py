from celery import Celery

from app.core.config import get_settings

settings = get_settings()

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
