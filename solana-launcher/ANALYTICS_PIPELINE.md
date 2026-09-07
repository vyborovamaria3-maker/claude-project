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

## Outcome and reputation projections

Performance-aware X/TG/wallet reliability must not rebuild historical joins on
every advanced report. `intelligence_entity_outcomes` stores one prepared row per
`entity_key + mint_address + horizon_hours`, selected from the earliest retained
snapshot where that entity appeared for the token.

The 72h outcome writer reconciles this projection in the same database transaction.
If an outcome is revised or becomes unusable, the corresponding projection row is
updated or removed instead of leaving a stale reputation vote. Migration
`0014_entity_outcome_projection` backfills existing matured 72h history.

Production PostgreSQL calculates source performance with one grouped query per
report, including exact median max multiple through `percentile_cont(0.5)`. The
SQLite development/test fallback preserves the same output contract in Python.
The semantic meaning does not change: historical performance is an association,
not proof that an actor caused a token outcome.

Matured 6h/24h/72h outcome evaluation also shares one bounded price-history read
per snapshot up to the largest pending horizon. The worker slices that retained
window in memory rather than issuing the same token/history queries three times.

## Campaign similarity projection

Historical campaign-neighbor lookup no longer loads up to 500 JSON fingerprints
into the API process and calculates cosine/Jaccard/sorting in Python. Migration
`0016_campaign_similarity_projection` backfills two prepared structures:

- `campaign_fingerprint_features`: one compact typed numeric row per v2 campaign
  fingerprint, including the 16 similarity dimensions, precomputed vector norm,
  actor count, mint and creation time;
- `campaign_fingerprint_actors`: deduplicated `snapshot_id + actor_key` membership
  used to calculate exact actor-set intersection counts.

New fingerprints maintain both structures in the same persistence transaction as
the durable `campaign_fingerprints` row. Historical lookup then performs one SQL
statement over the recent bounded projection: exact vector cosine, exact actor
Jaccard, the existing `0.75 * cosine + 0.25 * Jaccard` score, the `>= 0.5`
threshold, best-snapshot-per-mint deduplication and final top-10 ranking all happen
inside PostgreSQL. Only the final neighbors cross the application boundary.

The scoring contract therefore remains deterministic while JSON parsing, Python
pair scoring and Python sorting leave the request path. The projection is also the
explicit migration point for a future pgvector/ANN implementation: pgvector is not
a required production dependency until `campaign_similarity` timing and database
plans show that exact bounded SQL scoring has become material.

## Provider caching and single-flight

Wallet funding verification has a short (90 second) Redis cache keyed by both RPC
provider and wallet address. Concurrent requests for the same wallet use an atomic
owner-token lease and wait for the first result instead of multiplying
Helius/Solana `getTransaction` calls. Redis failure degrades to direct RPC rather
than making blockchain evidence unavailable.

Completed identical advanced reports are also cached for 30 minutes. The request
fingerprint includes snapshot data, AI result, role, enrichment and persistence
flags so materially different analysis contracts cannot share a cached result.

## Observability

In addition to provider/ingestion metrics, the architecture exposes:

- `analysis_cache_requests_total{layer,result}`
- `analysis_stage_runtime_seconds{stage}` including `campaign_similarity`,
  `funding_rpc`, `semantic_clustering` and `source_reliability`
- `analysis_end_to_end_runtime_seconds{result}`
- `celery_queue_wait_seconds{queue}`
- `celery_task_runtime_seconds{queue,result}`

Celery and Telegram emit metrics from separate processes. API and workers share a
Prometheus multiprocess directory so FastAPI `/metrics` aggregates those worker
series instead of exposing only API-local values.

Use the metrics together with provider latency/rate-limit series to decide whether
a slowdown is API CPU, PostgreSQL, queueing, Redis cache efficiency or an external
RPC/social provider.

## Scaling rules

Do not add Elasticsearch or ClickHouse merely because row counts grow. First run
the repository benchmark harness and inspect p50/p95/p99, queue wait, provider
latency and database plans.

- Keep transactional/latest state and moderate historical analytics in PostgreSQL.
- Add PostgreSQL FTS/`pg_trgm` before Elasticsearch/OpenSearch for social search.
- Keep campaign similarity on the typed exact-SQL projection while its measured
  p95 and query plan remain healthy; add pgvector/ANN only when that stage becomes
  material at larger fingerprint history sizes.
- Move append-heavy raw trade/event analytics to ClickHouse only when measured
  PostgreSQL write/scan cost justifies another datastore.
