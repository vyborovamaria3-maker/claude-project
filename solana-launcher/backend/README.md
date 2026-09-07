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

### Ingestion observability

`GET /metrics` exposes low-cardinality provider metrics suitable for Prometheus dashboards and alerts:

- `etl_provider_requests_total{provider,operation,result}` — HTTP/RPC attempts including status/result and transport errors.
- `etl_provider_retries_total{provider,operation,reason}` — retry attempts by reason.
- `etl_provider_rate_limits_total{provider,operation}` — provider HTTP 429 visibility.
- `etl_provider_request_latency_seconds{provider,operation}` — request-attempt histogram for p50/p95/p99 PromQL queries.
- `etl_ingestion_batch_runtime_seconds{provider}` — end-to-end ingestion batch duration.

Example p95 query:

```promql
histogram_quantile(
  0.95,
  sum by (le, provider, operation) (
    rate(etl_provider_request_latency_seconds_bucket[5m])
  )
)
```

## Social and blockchain analytics hot paths

X/Twitter ingestion batches one refresh into a single lookup of existing tweet IDs instead of issuing one `SELECT` per tweet. Duplicate provider rows are deduplicated before persistence while preserving the existing insert/update response contract.

Social timelines now push stable `mint + platform + occurred_at` filtering into PostgreSQL before source/engagement/call-specific Python filtering. Migration `0013_social_analytics_indexes` adds `ix_social_events_mint_platform_time` to support this path. Telegram channel-score filtering uses one narrow join against `telegram_channel_scores` instead of paging every complete channel row merely to build a score lookup.

Solana funding analysis now reuses one `httpx.AsyncClient` and one connection pool for all wallets in a snapshot. Wallet work is bounded separately from a global RPC semaphore, preventing per-wallet `getTransaction` fan-out from multiplying total Solana/Helius request concurrency. Solana RPC attempts and latency are exported through the same provider Prometheus metrics using `provider="solana_rpc"` and the JSON-RPC method as `operation`.

These changes optimize throughput without changing the evidence model: an incoming SOL transfer or common initial funder remains a graph clue, not proof of common ownership/control.

## Hot-path load testing

`scripts/load_hot_paths.py` is a small async HTTP load harness built on the backend's existing `httpx` dependency. It does not seed or delete data. `--dataset-size` only controls the random offset range; the target database must actually contain roughly that amount of data for the result to represent that scale.

For reproducible 10k/100k/1M tests, `scripts/seed_benchmark_data.py` can create synthetic token hot-state and optional wallet trades. It is intentionally guarded: it refuses `ENVIRONMENT=production|prod`, requires PostgreSQL, requires `--confirm-benchmark-db`, and expects the database name to look like a benchmark/staging/test/dev database unless an additional explicit override is supplied. Synthetic tokens use the `bench-token-` prefix and `status=benchmark`, so normal active-token Birdeye refreshes do not query their fake mint values.

```bash
# Point backend/.env at a disposable benchmark/staging PostgreSQL database first.
python scripts/seed_benchmark_data.py --tokens 10000 --confirm-benchmark-db
python scripts/seed_benchmark_data.py --tokens 100000 --wallet-trades 100000 --confirm-benchmark-db
python scripts/seed_benchmark_data.py --tokens 1000000 --confirm-benchmark-db

# Cleanup only benchmark-prefixed rows and the benchmark wallet.
python scripts/seed_benchmark_data.py --cleanup --confirm-benchmark-db
```

Run the API against that same benchmark database, obtain a subscriber/admin bearer token, and then benchmark:

```bash
export POTAPOFF_BENCH_URL=http://127.0.0.1:8000
export POTAPOFF_BENCH_TOKEN='<staging bearer token>'

python scripts/load_hot_paths.py tokens --dataset-size 10000 --requests 1000 --concurrency 25
python scripts/load_hot_paths.py tokens --dataset-size 100000 --requests 1000 --concurrency 25 --random-offsets
python scripts/load_hot_paths.py tokens --dataset-size 1000000 --requests 1000 --concurrency 25 --random-offsets

python scripts/load_hot_paths.py wallet \
  --wallet bench-wallet-hot-path \
  --dataset-size 100000 \
  --random-offsets

python scripts/load_hot_paths.py telegram-token --mint '<real staging mint>' --requests 500 --concurrency 20
```

The output is JSON with throughput, status-code counts, transport errors, successful/failed HTTP-response counts and latency `min/avg/p50/p95/p99/max`. Use `--json-out result.json` to keep a benchmark result.

Write scenarios are blocked unless explicitly enabled. `telegram-evaluate` and `collector` require `--allow-write-scenarios`; `collector` is additionally restricted to one request at concurrency one. Do not enable these against production merely to obtain benchmark numbers.
