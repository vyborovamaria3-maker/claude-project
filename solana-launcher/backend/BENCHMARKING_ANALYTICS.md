# POTAPoff analytics benchmark runbook

Use an isolated staging/benchmark PostgreSQL database. Do not run synthetic seeding or write-load scenarios against production.

## 1. Seed database-scale scenarios

```bash
python scripts/seed_benchmark_data.py --tokens 10000 --confirm-benchmark-db
python scripts/seed_benchmark_data.py --tokens 100000 --wallet-trades 100000 --confirm-benchmark-db
python scripts/seed_benchmark_data.py --tokens 1000000 --confirm-benchmark-db
```

Run one dataset size at a time when comparing results. Keep the application, PostgreSQL resources and worker concurrency unchanged between runs.

## 2. Measure read hot paths

```bash
export POTAPOFF_BENCH_URL=http://127.0.0.1:8000
export POTAPOFF_BENCH_TOKEN='<staging subscriber bearer token>'

python scripts/load_hot_paths.py tokens \
  --dataset-size 100000 \
  --requests 1000 \
  --concurrency 25 \
  --random-offsets \
  --json-out tokens-100k.json

python scripts/load_hot_paths.py wallet \
  --wallet bench-wallet-hot-path \
  --dataset-size 100000 \
  --requests 1000 \
  --concurrency 25 \
  --random-offsets \
  --json-out wallet-100k.json
```

The harness records RPS, HTTP failures and latency min/avg/p50/p95/p99/max.

## 3. Measure the two-phase advanced-intelligence pipeline

Save one real staging snapshot as `snapshot.json`. The benchmark defaults to `persist=false`, so generated per-request snapshot IDs do not create durable intelligence records. Each request gets a unique snapshot id by default to avoid measuring the completed-result cache instead of real work.

```bash
export POTAPOFF_BENCH_BACKEND_API_KEY='<staging BACKEND_API_KEY>'

python scripts/load_advanced_pipeline.py \
  --snapshot-json snapshot.json \
  --requests 50 \
  --concurrency 5 \
  --json-out advanced-unique.json
```

The output reports two latency distributions:

- `preliminary_latency_ms`: time until FastAPI returns the deterministic preliminary report / job handle.
- `final_completed_latency_ms`: wall time until the intelligence worker finishes enrichment and the job reaches `completed`.

To test cache and single-flight behavior instead of unique deep analyses:

```bash
python scripts/load_advanced_pipeline.py \
  --snapshot-json snapshot.json \
  --requests 50 \
  --concurrency 25 \
  --reuse-identical-request \
  --json-out advanced-singleflight.json
```

The output also counts `cached_responses` and `singleflight_reused_jobs`.

Persistence is intentionally opt-in and requires both flags:

```bash
python scripts/load_advanced_pipeline.py \
  --snapshot-json snapshot.json \
  --persist \
  --allow-persistence
```

Only use that mode on disposable staging data.

## 4. Prometheus measurements

### Queue wait p95 by isolated worker queue

```promql
histogram_quantile(
  0.95,
  sum by (le, queue) (
    rate(celery_queue_wait_seconds_bucket[5m])
  )
)
```

A high `intelligence` queue wait with low worker runtime means capacity/worker concurrency is the bottleneck. High runtime with low queue wait means the task itself is expensive.

### Worker runtime p95

```promql
histogram_quantile(
  0.95,
  sum by (le, queue, result) (
    rate(celery_task_runtime_seconds_bucket[5m])
  )
)
```

### Advanced-analysis stage p95

```promql
histogram_quantile(
  0.95,
  sum by (le, stage) (
    rate(analysis_stage_runtime_seconds_bucket[5m])
  )
)
```

`stage="campaign_similarity"` measures the exact SQL top-K lookup over the compact
campaign projection. If this stage stays small while fingerprint history grows,
do not add pgvector. If it becomes a persistent material share of preliminary
latency, capture `EXPLAIN (ANALYZE, BUFFERS)` for the generated query and compare an
ANN implementation against the same deterministic neighbor fixture before changing
the production scoring path.

Dedicated campaign-similarity p95:

```promql
histogram_quantile(
  0.95,
  sum by (le) (
    rate(analysis_stage_runtime_seconds_bucket{stage="campaign_similarity"}[5m])
  )
)
```

### Advanced-analysis end-to-end p95

```promql
histogram_quantile(
  0.95,
  sum by (le, result) (
    rate(analysis_end_to_end_runtime_seconds_bucket[5m])
  )
)
```

### Wallet-funding cache hit ratio

```promql
sum(rate(analysis_cache_requests_total{layer="wallet_funding",result=~"hit|wait_hit"}[5m]))
/
sum(rate(analysis_cache_requests_total{layer="wallet_funding"}[5m]))
```

### Advanced-report cache/single-flight rate

```promql
sum by (result) (
  rate(analysis_cache_requests_total{layer="advanced_report"}[5m])
)
```

### Solana/Helius RPC p95

```promql
histogram_quantile(
  0.95,
  sum by (le, operation) (
    rate(etl_provider_request_latency_seconds_bucket{provider="solana_rpc"}[5m])
  )
)
```

Also watch:

```promql
sum by (operation) (rate(etl_provider_rate_limits_total{provider="solana_rpc"}[5m]))
```

## 5. Interpretation order

Use the measurements in this order before adding another datastore:

1. HTTP p95/p99 for SQL hot paths.
2. Preliminary vs final advanced-analysis latency.
3. `campaign_similarity`, funding RPC, semantic clustering and source-reliability stage p95.
4. Queue wait vs worker runtime for each isolated Celery queue.
5. Helius/Solana RPC p95, errors and rate limits.
6. Redis cache/single-flight hit rate.
7. PostgreSQL query plans and database CPU/IO for the path that still dominates.

Only after measuring the above should POTAPoff introduce another storage engine. Use PostgreSQL projections/indexes first; pgvector/ANN for campaign/text similarity when measured; ClickHouse for append-heavy numeric/time-series analytics when measured; Elasticsearch/OpenSearch for global text search only when PostgreSQL FTS/pg_trgm is no longer sufficient.
