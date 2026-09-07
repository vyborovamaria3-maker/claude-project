# POTAPoff Backend

FastAPI backend for POTAPoff analytics, authentication, subscriptions, collectors, and background jobs.

## Local setup

1. Copy `.env.example` to `.env` and fill the required local values.
2. Install dependencies from `pyproject.toml`.
3. Apply Alembic migrations.
4. Start FastAPI and the Celery worker/beat processes, or use the project Docker Compose stack.

## Market-data ingestion tuning

Birdeye refreshes use bounded concurrency, connection pooling, retry/backoff for HTTP 429/5xx responses, and batched database flushes. The worker reads the following settings from `backend/.env` (or normal process environment variables):

- `BIRDEYE_REQUEST_CONCURRENCY` — maximum in-flight Birdeye HTTP requests; default `12`, allowed `1..64`.
- `BIRDEYE_TOKEN_BATCH_SIZE` — number of token observations fetched before one database flush; default `100`, allowed `1..1000`.
- `BIRDEYE_TIMEOUT_SECONDS` — per-request HTTP timeout; default `20`.
- `BIRDEYE_MAX_RETRIES` — retries for rate limits, transient 5xx responses, and network transport failures; default `3`.
- `BIRDEYE_BACKOFF_BASE_SECONDS` — exponential backoff base; default `0.5` seconds.
- `BIRDEYE_BACKOFF_MAX_SECONDS` — maximum backoff delay; default `8` seconds.

When Birdeye returns a numeric `Retry-After` header, that delay is preferred (bounded by `BIRDEYE_BACKOFF_MAX_SECONDS`). Otherwise the collector uses exponential backoff plus jitter. Backoff happens outside the request semaphore, so sleeping retries do not consume all provider concurrency slots.

Pump.fun token discovery uses a PostgreSQL `INSERT ... ON CONFLICT DO UPDATE` bulk upsert in production. PostgreSQL remains the durable source of truth; Redis failures on this ingestion path are treated as cache misses rather than collector failures.
