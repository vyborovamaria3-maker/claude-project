from __future__ import annotations

from prometheus_client import Counter, Histogram

TOKENS_PROCESSED = Counter("etl_tokens_processed_total", "Total tokens processed by ETL jobs")
WALLETS_PROCESSED = Counter("etl_wallets_processed_total", "Total wallets processed by ETL jobs")
WALLET_LINKS_CREATED = Counter(
    "etl_wallet_links_created_total", "Total wallet links created by ETL jobs"
)
ETL_ERRORS = Counter("etl_errors_total", "Total ETL errors")
ETL_RUNTIME = Histogram("etl_runtime_seconds", "ETL task runtime in seconds")
