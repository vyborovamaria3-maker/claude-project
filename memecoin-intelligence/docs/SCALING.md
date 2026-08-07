# Scaling plan

## Implemented in v3.2.0

1. API nodes are stateless.
2. Analysis jobs can run synchronously or through Redis/BullMQ.
3. Workers are independently deployable and have configurable concurrency.
4. Provider payloads can be normalized and inserted in PostgreSQL batches.
5. `x_posts` and `token_snapshots` use monthly partitions.
6. Post features are extracted once and stored with GIN/fingerprint indexes.
7. Account-network candidate generation is index-blocked instead of all-pairs.
8. Completed analyses are cached in Redis.
9. Benchmark data is generated as NDJSON and processed as a stream.

## Production growth path

- Put PgBouncer in front of PostgreSQL when API/worker replica counts grow.
- Create future partitions automatically before each month starts.
- Run `account_feature_summary` refreshes on a schedule, not inside API requests.
- Add Prometheus/OpenTelemetry for queue latency, DB latency, candidate count and memory.
- Archive old raw payloads to S3-compatible object storage.
- Add PostgreSQL read replicas for dashboards.
- Export `account_edges` to Apache AGE or Neo4j when graph traversal, rather than ingestion, becomes the dominant workload.
- Add pgvector only when a real embedding provider is selected; the portable schema currently stores embeddings as `real[]`.

## Safety limits

The graph engine intentionally has hard limits:

- `ANALYSIS_MAX_CANDIDATE_PAIRS`
- `ANALYSIS_MAX_FEATURE_FANOUT`
- `ANALYSIS_TIME_BUCKET_MINUTES`

These prevent a viral token or common URL from creating an unbounded graph in one process.
