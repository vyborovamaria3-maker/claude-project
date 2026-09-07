# POTAPoff Backend

FastAPI backend for the solana-launcher project.

## Stack
- FastAPI
- PostgreSQL
- SQLAlchemy 2.x + Alembic
- JWT auth
- SQLAdmin
- Redis
- Celery + RabbitMQ
- Prometheus metrics
- pytest
- Ruff + Mypy + pre-commit

## Local development
```bash
cp .env.example .env
pip install -e .[dev]
alembic upgrade head
uvicorn app.main:app --reload --port 8000
```

## Key endpoints
- `GET /health`
- `GET /ready`
- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/login-json`
- `POST /api/v1/auth/phantom/nonce`
- `POST /api/v1/auth/phantom/verify`
- `POST /api/v1/auth/telegram/verify`
- `POST /api/v1/auth/link`
- `GET /api/v1/users/me`
- `POST /api/v1/tasks/demo-notification`
- `GET /metrics`

## Hybrid auth notes
- `users.id` is now a UUID primary key.
- Phantom login uses a nonce issued by `/api/v1/auth/phantom/nonce` and verified by `/api/v1/auth/phantom/verify`.
- Telegram Mini App login is verified server-side via `/api/v1/auth/telegram/verify`.
- Account linking is handled by `/api/v1/auth/link` while preserving existing email/password login.
- Run `alembic upgrade head` after pulling the latest schema changes.

## Market-data ingestion tuning

Birdeye refreshes use bounded concurrency, connection pooling, retry/backoff for HTTP 429/5xx responses, and batched database flushes. The worker reads the following settings from `backend/.env` or normal process environment variables:

- `BIRDEYE_REQUEST_CONCURRENCY` — maximum in-flight Birdeye HTTP requests; default `12`, allowed `1..64`.
- `BIRDEYE_TOKEN_BATCH_SIZE` — token observations fetched before one database flush; default `100`, allowed `1..1000`.
- `BIRDEYE_TIMEOUT_SECONDS` — per-request HTTP timeout; default `20`.
- `BIRDEYE_MAX_RETRIES` — retries for rate limits, transient 5xx responses, and network transport failures; default `3`.
- `BIRDEYE_BACKOFF_BASE_SECONDS` — exponential backoff base; default `0.5` seconds.
- `BIRDEYE_BACKOFF_MAX_SECONDS` — maximum backoff delay; default `8` seconds.

When Birdeye returns a numeric `Retry-After` header, that delay is preferred, bounded by `BIRDEYE_BACKOFF_MAX_SECONDS`. Otherwise the collector uses exponential backoff plus jitter. Backoff happens outside the request semaphore, so sleeping retries do not consume provider concurrency slots.

Pump.fun token discovery uses a PostgreSQL `INSERT ... ON CONFLICT DO UPDATE` bulk upsert in production. PostgreSQL remains the durable source of truth; Redis failures on this ingestion path are treated as cache misses rather than collector failures.
