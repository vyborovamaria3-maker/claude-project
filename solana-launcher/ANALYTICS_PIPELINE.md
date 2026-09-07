# POTAPoff analytics pipeline

This document describes the intended runtime boundaries for market, social,
blockchain and intelligence analysis. PostgreSQL remains the durable source of
truth; Redis stores disposable hot state, deduplication locks and short-lived
analysis results; RabbitMQ/Celery isolates slow workloads from the API.

## Runtime topology

```text
Solana / Helius     X/Twitter        Telegram        Pump.fun / Birdeye
      |                 |               |                  |
      +-----------------+---------------+------------------+
                                |
                          normalize / ingest
                                |
                  +-------------+-------------+
                  |                           |
              PostgreSQL                   RabbitMQ
          history + projections               |
                  |          +----------------+----------------+----------------+
                  |          |                |                |                |
                  |       market           social         blockchain      intelligence
                  |       worker           worker           worker           worker
                  |          |                |                |                |
                  +----------+----------------+----------------+----------------+
                                             |
                                      Redis hot state
                                             |
                                           FastAPI
```

## Queue ownership

- `maintenance`: notifications and lightweight control-plane work.
- `market`: Pump.fun discovery, Birdeye metrics and full market collection.
- `social`: asynchronous X/Twitter refreshes.
- `blockchain`: wallet-link/cluster work and future standalone RPC enrichment jobs.
- `intelligence`: matured outcomes plus advanced report enrichment/persistence.

Workers subscribe to only one heavy queue. A slow RPC provider therefore cannot
starve market refreshes or notification/control work. `worker_prefetch_multiplier`
is deliberately `1` so a worker does not reserve a large backlog of long tasks.

## Telegram runtime boundary

Production FastAPI processes do not own the long-running Telegram collector.
`TG_RUNTIME_IN_API=false` is set by Compose and a dedicated
`python -m app.cli.telegram_runtime` process owns MTProto/public-web discovery,
call evaluation and outcome refreshes. The runtime publishes a short Redis
heartbeat at `telegram:runtime:status`; API status endpoints read that heartbeat.

Local direct development can still opt into the old in-process runtime by setting
`TG_RUNTIME_IN_API=true`. Long-running session/monitor controls are rejected by
API replicas when the external runtime is active so a request cannot accidentally
control the wrong process.

## Two-phase advanced intelligence

`POST /api/v1/social/intelligence/advanced/report` is retained as the synchronous
compatibility endpoint.

`POST /api/v1/social/intelligence/advanced/report/async` is the scalable path:

1. validate the snapshot and calculate a deterministic request fingerprint;
2. return a recently completed identical report from Redis when available;
3. single-flight identical in-progress requests so only one enrichment job runs;
4. build the deterministic preliminary report in the API process;
5. return HTTP 202 with the preliminary report and a job id;
6. run RPC enrichment and persistence in the `intelligence` queue;
7. publish the completed report to the job state and short-lived result cache.

Poll `GET /api/v1/social/intelligence/advanced/report/jobs/{job_id}` for the final
state. Job/payload/result entries currently live for 30 minutes and are not the
durable analytical record; persisted snapshots remain in PostgreSQL.

## Provider caching and single-flight

Wallet funding verification has a short (90 second) Redis cache keyed by both RPC
provider and wallet address. Concurrent requests for the same wallet use a Redis
lock and wait briefly for the first result instead of multiplying Helius/Solana
`getTransaction` calls. Redis failure degrades to direct RPC rather than making
blockchain evidence unavailable.

Completed identical advanced reports are also cached for 30 minutes. The request
fingerprint includes snapshot data, AI result, role, enrichment and persistence
flags so materially different analysis contracts cannot share a cached result.

## Observability

In addition to provider/ingestion metrics, the architecture exposes:

- `analysis_cache_requests_total{layer,result}`
- `analysis_stage_runtime_seconds{stage}`

Use these together with the existing provider latency/rate-limit metrics to decide
whether a slowdown is API CPU, PostgreSQL, queueing, Redis cache efficiency or an
external RPC/social provider.

## Scaling rules

Do not add Elasticsearch or ClickHouse merely because row counts grow. First run
the repository benchmark harness and inspect p50/p95/p99, queue wait, provider
latency and database plans.

- Keep transactional/latest state and moderate historical analytics in PostgreSQL.
- Add PostgreSQL FTS/`pg_trgm` before Elasticsearch/OpenSearch for social search.
- Add pgvector/ANN when campaign/text similarity outgrows bounded in-process scans.
- Move append-heavy raw trade/event analytics to ClickHouse only when measured
  PostgreSQL write/scan cost justifies another datastore.
