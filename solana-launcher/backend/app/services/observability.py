from __future__ import annotations

from prometheus_client import Counter, Histogram

TOKENS_PROCESSED = Counter(
    "etl_tokens_processed_total",
    "Total tokens processed by ETL jobs",
)
WALLETS_PROCESSED = Counter(
    "etl_wallets_processed_total",
    "Total wallets processed by ETL jobs",
)
WALLET_LINKS_CREATED = Counter(
    "etl_wallet_links_created_total",
    "Total wallet links created by ETL jobs",
)
ETL_ERRORS = Counter("etl_errors_total", "Total ETL errors")
ETL_RUNTIME = Histogram("etl_runtime_seconds", "ETL task runtime in seconds")

PROVIDER_REQUESTS = Counter(
    "etl_provider_requests_total",
    "Provider HTTP request attempts by provider, operation and result",
    ("provider", "operation", "result"),
)
PROVIDER_RETRIES = Counter(
    "etl_provider_retries_total",
    "Provider HTTP retries by provider, operation and reason",
    ("provider", "operation", "reason"),
)
PROVIDER_RATE_LIMITS = Counter(
    "etl_provider_rate_limits_total",
    "Provider HTTP 429 responses",
    ("provider", "operation"),
)
PROVIDER_REQUEST_LATENCY = Histogram(
    "etl_provider_request_latency_seconds",
    "Provider HTTP request-attempt latency in seconds",
    ("provider", "operation"),
    buckets=(0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 20.0, 30.0),
)
INGESTION_BATCH_RUNTIME = Histogram(
    "etl_ingestion_batch_runtime_seconds",
    "Market-ingestion batch runtime in seconds",
    ("provider",),
    buckets=(0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0),
)

ANALYSIS_CACHE_REQUESTS = Counter(
    "analysis_cache_requests_total",
    "Analysis cache lookups by layer and result",
    ("layer", "result"),
)
ANALYSIS_STAGE_RUNTIME = Histogram(
    "analysis_stage_runtime_seconds",
    "Advanced-intelligence stage runtime",
    ("stage",),
    buckets=(0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0),
)
ANALYSIS_END_TO_END_RUNTIME = Histogram(
    "analysis_end_to_end_runtime_seconds",
    "Advanced-intelligence wall time from accepted request to final worker result",
    ("result",),
    buckets=(0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 20.0, 30.0, 60.0, 120.0, 300.0),
)

CELERY_QUEUE_WAIT = Histogram(
    "celery_queue_wait_seconds",
    "Time a POTAPoff task waits between broker publish and worker start",
    ("queue",),
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0),
)
CELERY_TASK_RUNTIME = Histogram(
    "celery_task_runtime_seconds",
    "Worker execution time by isolated POTAPoff queue and result",
    ("queue", "result"),
    buckets=(0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0),
)
